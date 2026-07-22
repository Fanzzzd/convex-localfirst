/**
 * Fractional-index ("rank") module for ordering rows (kanban/manual order).
 *
 * Ranks are strings over a base-62, code-point-ascending alphabet. Because
 * ranks are canonical (never end in the lowest char '0'), plain JS string
 * comparison equals rank order.
 *
 * No imports, no dependencies — pure functions only.
 */

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const N = ALPHABET.length; // 62

function idx(ch: string): number {
  return ALPHABET.indexOf(ch);
}

/**
 * Returns a string strictly between `a` and `b` lexicographically.
 * `a === null` means negative infinity (smallest); `b === null` means
 * positive infinity (largest). Deterministic — no jitter.
 */
function between(a: string | null, b: string | null): string {
  let i = 0;
  let result = "";
  let upper = b; // may be set to null mid-loop
  while (true) {
    const digitA = a && i < a.length ? idx(a[i]) : 0;
    const digitB = upper && i < upper.length ? idx(upper[i]) : N; // N (=62) means "one past max"
    if (digitA === digitB) {
      result += ALPHABET[digitA];
      i++;
      continue;
    }
    const mid = Math.floor((digitA + digitB) / 2);
    if (mid !== digitA) {
      result += ALPHABET[mid];
      return result;
    }
    // mid === digitA (digitB === digitA + 1): emit digitA, drop the upper bound, keep scanning a
    result += ALPHABET[digitA];
    i++;
    upper = null;
  }
}

/**
 * Compares two ranks. Since ranks are canonical strings over a
 * code-point-ascending alphabet, plain string comparison gives rank order.
 */
export function rankCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * True iff `value` is a non-empty string, every char is in ALPHABET, and it
 * does not end with '0' (the lowest char). Never throws.
 */
export function isValidRank(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  for (let i = 0; i < value.length; i++) {
    if (idx(value[i]) === -1) return false;
  }
  if (value[value.length - 1] === "0") return false;
  return true;
}

/**
 * Returns a new rank strictly between `a` and `b` (a=null => smallest,
 * b=null => largest), with random jitter appended so concurrent calls with
 * the same inputs diverge.
 */
export function rankBetween(a: string | null, b: string | null): string {
  if (a != null && !isValidRank(a)) {
    throw new Error("rankBetween: a is not a valid rank");
  }
  if (b != null && !isValidRank(b)) {
    throw new Error("rankBetween: b is not a valid rank");
  }
  if (a != null && b != null && rankCompare(a, b) >= 0) {
    throw new Error("rankBetween: a must be strictly less than b");
  }

  const base = between(a, b);

  // Append 2 jitter chars; the last must not be '0' so the result stays
  // canonical. The first jitter char may be any index.
  const firstJitter = ALPHABET[Math.floor(Math.random() * N)];
  const lastJitter = ALPHABET[1 + Math.floor(Math.random() * (N - 1))];

  return base + firstJitter + lastJitter;
}

/**
 * Returns `ranks.length` new canonical ranks in strictly ascending order,
 * evenly re-spread to reclaim precision. Only the count of `ranks` matters.
 */
export function rebalance(ranks: readonly string[]): string[] {
  const n = ranks.length;
  if (n === 0) return [];
  const out = new Array<string>(n);

  function fill(
    lo: number,
    hi: number,
    low: string | null,
    high: string | null,
  ): void {
    if (lo > hi) return;
    const mid = (lo + hi) >> 1;
    const key = between(low, high);
    out[mid] = key;
    fill(lo, mid - 1, low, key);
    fill(mid + 1, hi, key, high);
  }

  fill(0, n - 1, null, null);
  return out;
}
