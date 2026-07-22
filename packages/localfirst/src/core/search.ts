import type { LocalFirstManifest } from "./manifest.js";
import type { RowDelta, RowValue, TableName } from "./types.js";

/**
 * Local full-text search (P4). A memory-resident incremental inverted index over the
 * `searchFields` declared on lf.table, maintained from the SAME row deltas as the P3
 * cache — never by rescanning tables after boot. The index is built once from the
 * hydrated cache, then every insert/patch/delete flows in as a delta.
 *
 * Search is search-as-you-type: the query is tokenized, every complete (non-final)
 * token must match a whole row token, and the FINAL token prefix-matches (so results
 * update on each keystroke). Ranking is field-weighted (earlier `searchFields` weigh
 * more), rewards exact over prefix matches and more matched tokens, and breaks ties by
 * a recency field (`updated_at`/`updatedAt`) when present, else by row id.
 *
 * No dependencies. All lookups are memory-resident and O(matches), so a lookup is fast
 * enough to run on every keystroke with no debounce.
 */

// Match-type weights: an exact whole-token match beats a mere prefix match.
const MATCH_EXACT = 2;
const MATCH_PREFIX = 1;

/** True when a string value looks like HTML (carries a tag), so it should be
 *  tag-stripped before tokenizing (e.g. a `description_html` field). */
export function looksLikeHtml(value: string): boolean {
  return /<[a-z!/][^>]*>/i.test(value);
}

// A handful of common named/numeric entities — enough that stripped HTML tokenizes
// sanely without pulling in a full entity table.
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** Drop HTML tags (and decode a few entities), leaving plain text to tokenize. */
export function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ");
}

// Runs of Unicode letters/numbers — the token boundary. Everything else (punctuation,
// whitespace, symbols) splits. Unicode-aware so accented text and non-Latin scripts
// tokenize correctly.
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

/**
 * Tokenize a field value: coerce to text (arrays are space-joined), strip HTML when the
 * value looks like HTML, unicode-lowercase, and split on non-alphanumerics.
 */
export function tokenize(value: unknown): string[] {
  if (value == null) return [];
  let text: string;
  if (typeof value === "string") text = value;
  else if (Array.isArray(value)) text = value.map((v) => (v == null ? "" : String(v))).join(" ");
  else text = String(value);
  if (text.length === 0) return [];
  if (looksLikeHtml(text)) text = stripHtml(text);
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const match of lower.matchAll(TOKEN_RE)) out.push(match[0]);
  return out;
}

/** Recency value for tie-break: the row's `updated_at`/`updatedAt` when numeric, else null. */
function recencyOf(row: RowValue): number | null {
  const r = row as Record<string, unknown>;
  const v = r.updated_at ?? r.updatedAt;
  return typeof v === "number" ? v : null;
}

export type SearchHit = { readonly id: string; readonly score: number };
export type IndexSearchResult = { readonly ids: string[]; readonly total: number };
export type SearchQueryOptions = {
  readonly limit?: number;
  /** Post-filter (scope): a row id is kept only when this returns true. */
  readonly filter?: (id: string) => boolean;
};

/**
 * A single table's inverted index. Pure and cache-independent (it stores only ids and
 * tokens), so it is unit-testable in isolation and reusable by the perf bench.
 */
export class SearchIndex {
  // token -> (rowId -> field bitmask). The bitmask records WHICH searchFields contain the
  // token for that row, so scoring can pick the highest-weight field in O(#fields).
  private readonly postings = new Map<string, Map<string, number>>();
  // Per row: the token set of each field (for exact removal) + the recency tie-break value.
  private readonly rows = new Map<
    string,
    { readonly fieldTokens: Set<string>[]; readonly recency: number | null }
  >();
  // Sorted distinct vocabulary, rebuilt lazily (dirty flag) for binary-search prefix ranges.
  private vocab: string[] = [];
  private vocabDirty = false;
  private readonly fieldWeights: number[];

  constructor(readonly fields: readonly string[]) {
    // Earlier fields weigh more: field 0 gets the largest weight. (Weights are strictly
    // decreasing and positive, so field order is the dominant ranking signal.)
    this.fieldWeights = fields.map((_, i) => fields.length - i);
  }

  get size(): number {
    return this.rows.size;
  }

  /** Index (or re-index) a row from its raw field values (in `fields` order) + recency. */
  add(id: string, fieldValues: readonly unknown[], recency: number | null): void {
    if (this.rows.has(id)) this.remove(id);
    const fieldTokens: Set<string>[] = [];
    for (let i = 0; i < this.fields.length; i++) {
      const tokens = new Set(tokenize(fieldValues[i]));
      fieldTokens.push(tokens);
      const bit = 1 << i;
      for (const token of tokens) {
        let posting = this.postings.get(token);
        if (!posting) {
          posting = new Map();
          this.postings.set(token, posting);
          this.vocabDirty = true;
        }
        posting.set(id, (posting.get(id) ?? 0) | bit);
      }
    }
    this.rows.set(id, { fieldTokens, recency });
  }

  remove(id: string): void {
    const entry = this.rows.get(id);
    if (!entry) return;
    for (const tokens of entry.fieldTokens) {
      for (const token of tokens) {
        const posting = this.postings.get(token);
        if (!posting) continue;
        posting.delete(id);
        if (posting.size === 0) {
          this.postings.delete(token);
          this.vocabDirty = true;
        }
      }
    }
    this.rows.delete(id);
  }

  private ensureVocab(): void {
    if (!this.vocabDirty) return;
    this.vocab = [...this.postings.keys()].sort();
    this.vocabDirty = false;
  }

  /** Distinct indexed tokens that start with `prefix`, via binary search on the vocab. */
  private tokensWithPrefix(prefix: string): string[] {
    this.ensureVocab();
    const vocab = this.vocab;
    // Leftmost token >= prefix.
    let lo = 0;
    let hi = vocab.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (vocab[mid]! < prefix) lo = mid + 1;
      else hi = mid;
    }
    const out: string[] = [];
    for (let i = lo; i < vocab.length; i++) {
      const token = vocab[i]!;
      if (!token.startsWith(prefix)) break;
      out.push(token);
    }
    return out;
  }

  /** Highest field weight among the fields whose bit is set (field 0 = highest weight,
   *  so the first set bit from the low end is the answer). */
  private bestWeight(mask: number): number {
    for (let i = 0; i < this.fieldWeights.length; i++) {
      if (mask & (1 << i)) return this.fieldWeights[i]!;
    }
    return 0;
  }

  /**
   * Rank rows against a raw query string. Every complete token is required (exact); the
   * final token is required as a prefix. Returns the matching ids in ranked order (capped
   * by `limit`) plus the total match count (pre-limit, post-filter).
   */
  search(rawQuery: string, options?: SearchQueryOptions): IndexSearchResult {
    const tokens = tokenize(rawQuery);
    if (tokens.length === 0) return { ids: [], total: 0 };
    const last = tokens[tokens.length - 1]!;
    const complete = tokens.slice(0, -1);
    const filter = options?.filter;

    // Prefix contribution per candidate row: sum over the row's tokens matching the prefix
    // of (bestFieldWeight * matchType). Summing rewards a row that matches the prefix in
    // MORE tokens/fields ("more matched tokens beat fewer"); an exact hit (row token equals
    // the query token) scores above a longer prefix-only hit ("exact beats prefix").
    const prefixScore = new Map<string, number>();
    for (const token of this.tokensWithPrefix(last)) {
      const posting = this.postings.get(token);
      if (!posting) continue;
      const matchType = token === last ? MATCH_EXACT : MATCH_PREFIX;
      for (const [id, mask] of posting) {
        prefixScore.set(id, (prefixScore.get(id) ?? 0) + this.bestWeight(mask) * matchType);
      }
    }
    if (prefixScore.size === 0) return { ids: [], total: 0 };

    const hits: Array<{ id: string; score: number; recency: number | null }> = [];
    for (const [id, base] of prefixScore) {
      if (filter && !filter(id)) continue;
      let score = base;
      let matched = true;
      for (const token of complete) {
        const mask = this.postings.get(token)?.get(id);
        if (mask === undefined) {
          matched = false;
          break;
        }
        score += this.bestWeight(mask) * MATCH_EXACT;
      }
      if (!matched) continue;
      hits.push({ id, score, recency: this.rows.get(id)?.recency ?? null });
    }

    hits.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score; // higher score first
      // Recency: newer (larger) first; rows without a recency value sort last.
      if (a.recency !== b.recency) {
        if (a.recency == null) return 1;
        if (b.recency == null) return -1;
        return b.recency - a.recency;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // stable final tie-break
    });

    const total = hits.length;
    const limit = options?.limit;
    const ids = (limit != null && limit >= 0 ? hits.slice(0, limit) : hits).map((h) => h.id);
    return { ids, total };
  }

  clear(): void {
    this.postings.clear();
    this.rows.clear();
    this.vocab = [];
    this.vocabDirty = false;
  }
}

export type SearchResult<Row extends Record<string, unknown> = RowValue> = {
  readonly results: Row[];
  readonly total: number;
};

export type SearchScope = Record<string, unknown>;
export type SearchOptions = {
  readonly scope?: SearchScope;
  readonly limit?: number;
};

/** The slice of the P3 cache the search layer reads — the same delta bus + row lookups
 *  every other reactive view uses. */
export type SearchCache = {
  readonly isHydrated: boolean;
  hydrate(): Promise<void>;
  tableRows(table: TableName): readonly RowValue[];
  visibleRow(table: TableName, id: string): RowValue | undefined;
  subscribeDeltas(listener: (deltas: readonly RowDelta[]) => void): () => void;
};

const EMPTY_RESULT: SearchResult = { results: [], total: 0 };

/**
 * Owns every searchable table's index and every live search subscription. Built once
 * from the hydrated cache, then maintained purely from the cache's row-delta bus. A
 * delta touching a searchable table updates that table's index and refreshes only the
 * live searches on that table.
 */
export class SearchManager {
  private readonly indexes = new Map<TableName, SearchIndex>();
  private readonly views = new Set<SearchView>();
  private readonly viewsByTable = new Map<TableName, Set<SearchView>>();
  private built = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly cache: SearchCache,
    private readonly manifest: LocalFirstManifest,
  ) {
    // Subscribe BEFORE building so no live delta can slip through the gap between build
    // completion and the first delta. Pre-build deltas are ignored: the build snapshot
    // reads cache.tableRows AFTER the cache has already applied them (setVisible runs
    // before commit emits the delta), so the snapshot is never stale.
    this.unsubscribe = cache.subscribeDeltas((deltas) => this.onDeltas(deltas));
    if (cache.isHydrated) this.build();
    else void cache.hydrate().then(() => this.build());
  }

  private searchFieldsOf(table: TableName): readonly string[] | null {
    const fields = this.manifest.tables[table]?.searchFields;
    return fields && fields.length > 0 ? fields : null;
  }

  private build(): void {
    if (this.built) return;
    for (const table of Object.keys(this.manifest.tables)) {
      const fields = this.searchFieldsOf(table);
      if (!fields) continue;
      const index = new SearchIndex(fields);
      for (const row of this.cache.tableRows(table)) {
        index.add(
          row._id,
          fields.map((f) => (row as Record<string, unknown>)[f]),
          recencyOf(row),
        );
      }
      this.indexes.set(table, index);
    }
    this.built = true;
    // Views that subscribed before hydration finished now have data — notify each.
    for (const view of this.views) view.refresh();
  }

  private onDeltas(deltas: readonly RowDelta[]): void {
    if (!this.built) return;
    const touched = new Set<TableName>();
    for (const delta of deltas) {
      const index = this.indexes.get(delta.table);
      if (!index) continue;
      const fields = this.searchFieldsOf(delta.table)!; // present iff the index exists
      if (delta.kind === "delete") index.remove(delta.localId);
      else
        index.add(
          delta.localId,
          fields.map((f) => (delta.row as Record<string, unknown>)[f]),
          recencyOf(delta.row),
        );
      touched.add(delta.table);
    }
    for (const table of touched) {
      const views = this.viewsByTable.get(table);
      if (views) for (const view of views) view.refresh();
    }
  }

  /** @internal Run a one-shot ranked search resolving ids to live cache rows. */
  run(table: TableName, query: string, options?: SearchOptions): SearchResult {
    const index = this.indexes.get(table);
    if (!index) return EMPTY_RESULT;
    const scope = options?.scope;
    const filter =
      scope && Object.keys(scope).length > 0
        ? (id: string) => matchesScope(this.cache.visibleRow(table, id), scope)
        : undefined;
    const { ids, total } = index.search(query, { limit: options?.limit, filter });
    const results: RowValue[] = [];
    for (const id of ids) {
      const row = this.cache.visibleRow(table, id);
      if (row) results.push(row);
    }
    return { results, total };
  }

  /** Register a live search. `onChange` fires only when the visible result changes;
   *  `current()` returns the maintained result (stable array identity while unchanged). */
  subscribe(
    table: TableName,
    query: string,
    options: SearchOptions | undefined,
    onChange: () => void,
  ): {
    current(): SearchResult;
    dispose(): void;
  } {
    const view = new SearchView(this, table, query, options, onChange);
    this.views.add(view);
    let set = this.viewsByTable.get(table);
    if (!set) {
      set = new Set();
      this.viewsByTable.set(table, set);
    }
    set.add(view);
    if (this.built) view.populate();
    return {
      current: () => view.current(),
      dispose: () => {
        this.views.delete(view);
        const bucket = this.viewsByTable.get(table);
        if (bucket) {
          bucket.delete(view);
          if (bucket.size === 0) this.viewsByTable.delete(table);
        }
      },
    };
  }

  dispose(): void {
    this.unsubscribe();
    this.views.clear();
    this.viewsByTable.clear();
    this.indexes.clear();
  }
}

/** True when `row` matches every equality in `scope`. A missing row fails closed. */
function matchesScope(row: RowValue | undefined, scope: SearchScope): boolean {
  if (!row) return false;
  for (const [field, value] of Object.entries(scope)) {
    if ((row as Record<string, unknown>)[field] !== value) return false;
  }
  return true;
}

/** One live search: recomputes on refresh and emits only when the result truly changed. */
class SearchView {
  private result: SearchResult = EMPTY_RESULT;

  constructor(
    private readonly manager: SearchManager,
    private readonly table: TableName,
    private readonly query: string,
    private readonly options: SearchOptions | undefined,
    private readonly onChange: () => void,
  ) {}

  /** Compute + store WITHOUT notifying (initial read; the hook reads current() itself). */
  populate(): void {
    this.result = this.manager.run(this.table, this.query, this.options);
  }

  /** Recompute; notify only if the visible result actually changed. */
  refresh(): void {
    const next = this.manager.run(this.table, this.query, this.options);
    if (equalResult(this.result, next)) return;
    this.result = next;
    this.onChange();
  }

  current(): SearchResult {
    return this.result;
  }
}

/** Result equality by row-reference identity (rows are never mutated in place, so a
 *  changed row is a fresh reference) — gives stable array identity when nothing changed. */
function equalResult(a: SearchResult, b: SearchResult): boolean {
  if (a.total !== b.total || a.results.length !== b.results.length) return false;
  for (let i = 0; i < a.results.length; i++) if (a.results[i] !== b.results[i]) return false;
  return true;
}
