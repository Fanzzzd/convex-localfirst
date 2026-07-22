import * as React from "react";
import { useLocalFirstEngine } from "../react/index.js";

/**
 * LocalFirstDevtools — a dev-only, zero-dependency (beyond React) inspector panel for the
 * local-first engine (DX v4 §8). Mount it MANUALLY inside your provider — there is no
 * auto-injection:
 *
 * ```tsx
 * import { LocalFirstDevtools } from "convex-localfirst/devtools";
 * // ...
 * <ConvexProvider client={convex} localFirst={{ modules, userId }}>
 *   <App />
 *   {import.meta.env.DEV && <LocalFirstDevtools />}
 * </ConvexProvider>
 * ```
 *
 * It renders nothing in a production build (`process.env.NODE_ENV === "production"`) unless
 * `force` is set. Fixed to the bottom-right, collapsible, dark-themed, inline styles only —
 * no external CSS, no pixel dependencies.
 *
 * Tabs: Sync (per-scope cursor/hydrated/partial/denied/role + global status + recovery),
 * Outbox (pending/pushing/rejected ops), Queries (live views + plan explain), Storage (row
 * counts, attachment blobs, search indexes), plus a simulate-offline toggle.
 */
export type LocalFirstDevtoolsProps = {
  /** Start expanded instead of collapsed. */
  readonly defaultOpen?: boolean;
  /** Render even in a production build. Off by default (the panel disappears in prod). */
  readonly force?: boolean;
  /** How often (ms) to refresh the store-backed tabs (outbox/storage/scopes). Default 750. */
  readonly pollMs?: number;
};

type Tab = "sync" | "outbox" | "queries" | "storage";

const IS_PROD = typeof process !== "undefined" && process.env?.NODE_ENV === "production";

const palette = {
  bg: "#14151a",
  panel: "#1c1e26",
  border: "#2c2f3a",
  text: "#e6e7eb",
  dim: "#9aa0ad",
  accent: "#7c5cff",
  good: "#37b26b",
  warn: "#d8a13a",
  bad: "#e05563"
};

const monospace = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

type ScopeRow = Awaited<ReturnType<import("../core/index.js").LocalFirstEngine["debugScopes"]>>[number];
type OutboxRow = Awaited<ReturnType<import("../core/index.js").LocalFirstEngine["debugOutbox"]>>[number];
type StorageData = Awaited<ReturnType<import("../core/index.js").LocalFirstEngine["debugStorage"]>>;
type QueryRow = ReturnType<import("../core/index.js").LocalFirstEngine["debugQueries"]>[number];

export function LocalFirstDevtools(props: LocalFirstDevtoolsProps = {}): React.ReactElement | null {
  const engine = useLocalFirstEngine();
  const [open, setOpen] = React.useState(props.defaultOpen ?? false);
  const [tab, setTab] = React.useState<Tab>("sync");
  const [, forceRender] = React.useReducer((n: number) => n + 1, 0);

  const [scopes, setScopes] = React.useState<ScopeRow[]>([]);
  const [outbox, setOutbox] = React.useState<OutboxRow[]>([]);
  const [storage, setStorage] = React.useState<StorageData | null>(null);

  // Live status (push-notified) — re-render on any status/role/undo transition.
  React.useEffect(() => {
    if (!engine) return;
    const unsubs = [engine.subscribeStatus(forceRender), engine.subscribeRoles(forceRender), engine.subscribeUndo(forceRender)];
    return () => unsubs.forEach((u) => u());
  }, [engine]);

  // Store-backed tabs are polled (they are not push-notified) while the panel is open.
  React.useEffect(() => {
    if (!engine || !open) return;
    let alive = true;
    const refresh = async () => {
      const [nextScopes, nextOutbox, nextStorage] = await Promise.all([
        engine.debugScopes(),
        engine.debugOutbox(),
        engine.debugStorage()
      ]);
      if (!alive) return;
      setScopes(nextScopes);
      setOutbox(nextOutbox);
      setStorage(nextStorage);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), props.pollMs ?? 750);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [engine, open, props.pollMs]);

  if (!engine || (IS_PROD && !props.force)) return null;

  const status = engine.getStatus();
  const queries = engine.debugQueries();
  const pending = outbox.filter((op) => op.status === "pending" || op.status === "pushing").length;

  const container: React.CSSProperties = {
    position: "fixed",
    right: 12,
    bottom: 12,
    zIndex: 2147483000,
    fontFamily: monospace,
    fontSize: 12,
    color: palette.text
  };

  if (!open) {
    return (
      <div style={container} data-testid="lf-devtools">
        <button
          type="button"
          data-testid="lf-devtools-toggle"
          onClick={() => setOpen(true)}
          style={{
            ...btnBase,
            background: palette.panel,
            border: `1px solid ${palette.border}`,
            display: "flex",
            alignItems: "center",
            gap: 6
          }}
        >
          <Dot color={status.online ? (status.syncing ? palette.warn : palette.good) : palette.bad} />
          <span>local-first</span>
          {pending > 0 && <Badge>{pending}</Badge>}
        </button>
      </div>
    );
  }

  return (
    <div style={container} data-testid="lf-devtools">
      <div
        style={{
          width: 380,
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          background: palette.bg,
          border: `1px solid ${palette.border}`,
          borderRadius: 8,
          boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
          overflow: "hidden"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: `1px solid ${palette.border}`, background: palette.panel }}>
          <Dot color={status.online ? (status.syncing ? palette.warn : palette.good) : palette.bad} />
          <strong style={{ flex: 1 }}>local-first devtools</strong>
          <label style={{ display: "flex", alignItems: "center", gap: 4, color: palette.dim, cursor: "pointer" }}>
            <input
              type="checkbox"
              data-testid="lf-devtools-offline-toggle"
              checked={!status.online}
              onChange={(event) => engine.setOnline(!event.target.checked)}
            />
            offline
          </label>
          <button type="button" data-testid="lf-devtools-close" onClick={() => setOpen(false)} style={{ ...btnBase, background: "transparent", border: "none", color: palette.dim }}>
            ✕
          </button>
        </div>

        <div style={{ display: "flex", gap: 2, padding: "6px 8px", borderBottom: `1px solid ${palette.border}` }}>
          {(["sync", "outbox", "queries", "storage"] as const).map((name) => (
            <button
              key={name}
              type="button"
              data-testid={`lf-devtools-tab-${name}`}
              onClick={() => setTab(name)}
              style={{
                ...btnBase,
                flex: 1,
                background: tab === name ? palette.accent : "transparent",
                border: `1px solid ${tab === name ? palette.accent : palette.border}`,
                color: tab === name ? "#fff" : palette.dim
              }}
            >
              {name}
              {name === "outbox" && pending > 0 ? ` (${pending})` : ""}
            </button>
          ))}
        </div>

        <div style={{ overflow: "auto", padding: 10 }} data-testid={`lf-devtools-panel-${tab}`}>
          {tab === "sync" && <SyncTab status={status} scopes={scopes} />}
          {tab === "outbox" && <OutboxTab outbox={outbox} />}
          {tab === "queries" && <QueriesTab queries={queries} />}
          {tab === "storage" && <StorageTab storage={storage} />}
        </div>
      </div>
    </div>
  );
}

function SyncTab(props: { status: import("../core/index.js").SyncStatus; scopes: ScopeRow[] }): React.ReactElement {
  const { status, scopes } = props;
  const recovery = status.recovery;
  const recoveryCount =
    recovery.rejectedOperations.length +
    recovery.olderSchemaOperations.length +
    recovery.failedAttachments.length +
    recovery.failedGroups.length;
  return (
    <div>
      <Row label="online" value={String(status.online)} tone={status.online ? "good" : "bad"} />
      <Row label="syncing" value={String(status.syncing)} />
      <Row label="pending" value={String(status.pendingMutations)} tone={status.pendingMutations > 0 ? "warn" : undefined} />
      <Row label="partial" value={String(status.partial)} tone={status.partial ? "warn" : undefined} />
      {status.blockedBySchemaMismatch && <Row label="schema" value="mismatch — client must upgrade" tone="bad" />}
      {status.lastError && <Row label="lastError" value={status.lastError} tone="bad" />}
      <Row label="recovery" value={String(recoveryCount)} tone={recoveryCount > 0 ? "bad" : undefined} />
      <Section title={`scopes (${scopes.length})`} />
      {scopes.length === 0 && <Empty>no scopes synced yet</Empty>}
      {scopes.map((scope) => (
        <div key={scope.scopeKey} data-testid="lf-devtools-scope" style={cardStyle}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Dot color={scope.denied ? palette.bad : scope.hydrated ? palette.good : palette.warn} />
            <span style={{ flex: 1, wordBreak: "break-all" }}>{scope.scopeKey}</span>
          </div>
          <div style={{ color: palette.dim, marginTop: 2 }}>
            {tagList([
              scope.hydrated ? "hydrated" : "hydrating",
              scope.partial ? "partial" : null,
              scope.syncing ? "syncing" : null,
              scope.denied ? "denied" : null,
              scope.role !== undefined ? `role=${JSON.stringify(scope.role)}` : null,
              `cursor=${scope.cursor ?? "∅"}`
            ])}
          </div>
        </div>
      ))}
    </div>
  );
}

function OutboxTab(props: { outbox: OutboxRow[] }): React.ReactElement {
  const { outbox } = props;
  const now = Date.now();
  if (outbox.length === 0) return <Empty>outbox is empty</Empty>;
  return (
    <div>
      {outbox.map((op) => (
        <div key={op.opId} data-testid="lf-devtools-op" style={cardStyle}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ ...pill, background: kindColor(op.kind) }}>{op.kind}</span>
            <span style={{ flex: 1 }}>
              {op.table}
              {op.groupId ? " · group" : ""}
            </span>
            <span style={{ ...pill, background: statusColor(op.status) }}>{op.status}</span>
          </div>
          <div style={{ color: palette.dim, marginTop: 2 }}>
            {op.functionName} · {op.id}
            {op.error ? ` · ${op.error}` : ` · ${Math.max(0, Math.round((now - op.createdAt) / 1000))}s`}
          </div>
        </div>
      ))}
    </div>
  );
}

function QueriesTab(props: { queries: QueryRow[] }): React.ReactElement {
  const { queries } = props;
  if (queries.length === 0) return <Empty>no live queries mounted</Empty>;
  return (
    <div>
      {queries.map((query, index) => (
        <div key={index} data-testid="lf-devtools-query" style={cardStyle}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ ...pill, background: query.kind === "counts" ? palette.warn : palette.accent }}>{query.kind}</span>
            <span style={{ flex: 1 }}>{query.table}</span>
            <span style={{ ...pill, background: query.explain.strategy === "index" ? palette.good : palette.border }}>
              {query.explain.strategy === "index" ? `index:${query.explain.index}` : "scan"}
            </span>
          </div>
          <div style={{ color: palette.dim, marginTop: 2 }}>
            {tagList([
              `rows=${query.rows}`,
              query.groups != null ? `groups=${query.groups}` : null,
              query.explain.order ? `order=${query.explain.order.field} ${query.explain.order.dir}` : null,
              query.explain.limit != null ? `limit=${query.explain.limit}` : null
            ])}
          </div>
        </div>
      ))}
    </div>
  );
}

function StorageTab(props: { storage: StorageData | null }): React.ReactElement {
  const { storage } = props;
  if (!storage) return <Empty>loading…</Empty>;
  return (
    <div>
      <Section title="tables" />
      {storage.tables.map((table) => (
        <Row key={table.table} label={table.table} value={`${table.rows} rows`} />
      ))}
      <Section title="attachments" />
      <Row label="blobs" value={`${storage.attachments.count} · ${formatBytes(storage.attachments.bytes)}`} />
      <Section title="search indexes" />
      {storage.search.filter((s) => s.indexed).length === 0 && <Empty>none</Empty>}
      {storage.search.filter((s) => s.indexed).map((s) => (
        <Row key={s.table} label={s.table} value="indexed" tone="good" />
      ))}
    </div>
  );
}

// ---- Small presentational helpers (inline-styled) ---------------------------

const btnBase: React.CSSProperties = {
  padding: "4px 8px",
  borderRadius: 6,
  cursor: "pointer",
  color: palette.text,
  font: "inherit"
};
const cardStyle: React.CSSProperties = {
  padding: "6px 8px",
  marginBottom: 6,
  background: palette.panel,
  border: `1px solid ${palette.border}`,
  borderRadius: 6
};
const pill: React.CSSProperties = {
  padding: "1px 6px",
  borderRadius: 4,
  fontSize: 10,
  color: "#fff",
  textTransform: "uppercase",
  letterSpacing: 0.3
};

const toneColor = (tone?: "good" | "warn" | "bad") =>
  tone === "good" ? palette.good : tone === "warn" ? palette.warn : tone === "bad" ? palette.bad : palette.text;

function Row(props: { label: string; value: string; tone?: "good" | "warn" | "bad" }): React.ReactElement {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "2px 0" }}>
      <span style={{ color: palette.dim }}>{props.label}</span>
      <span style={{ color: toneColor(props.tone), wordBreak: "break-all", textAlign: "right" }}>{props.value}</span>
    </div>
  );
}

function Section(props: { title: string }): React.ReactElement {
  return (
    <div style={{ margin: "8px 0 4px", color: palette.dim, textTransform: "uppercase", fontSize: 10, letterSpacing: 0.5 }}>
      {props.title}
    </div>
  );
}

function Empty(props: { children: React.ReactNode }): React.ReactElement {
  return <div style={{ color: palette.dim, fontStyle: "italic", padding: "4px 0" }}>{props.children}</div>;
}

function Dot(props: { color: string }): React.ReactElement {
  return <span style={{ width: 8, height: 8, borderRadius: "50%", background: props.color, display: "inline-block" }} />;
}

function Badge(props: { children: React.ReactNode }): React.ReactElement {
  return (
    <span style={{ ...pill, background: palette.warn, minWidth: 16, textAlign: "center" }}>{props.children}</span>
  );
}

function tagList(tags: Array<string | null>): string {
  return tags.filter((t): t is string => t != null).join(" · ");
}

function kindColor(kind: string): string {
  return kind === "insert" ? palette.good : kind === "delete" ? palette.bad : palette.accent;
}

function statusColor(status: string): string {
  return status === "rejected" ? palette.bad : status === "pushing" ? palette.warn : status === "acked" ? palette.accent : palette.border;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
