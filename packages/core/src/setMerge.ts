/**
 * Set-field merge: convergent add/remove for array fields declared as sets (e.g.
 * `label_ids`). A set-field patch is recorded as an add/remove DELTA (vs the value the
 * client saw); merge applies `(current ∪ add) \ remove` on both client replay and server,
 * so concurrent adds/removes to different elements all survive instead of LWW-clobbering.
 * Delta-based grow/shrink set (not a tagged OR-Set): concurrent add+remove of the SAME
 * element is a genuine conflict resolved by apply order.
 */

/** A patch field carrying a set delta instead of a replacement value. */
export type SetDelta = { readonly __lfSet: { readonly add: readonly unknown[]; readonly remove: readonly unknown[] } };

/**
 * Counter-field merge: convergent add/subtract for numeric fields declared as counters
 * (e.g. `vote_count`). A counter-field patch is recorded as a numeric DELTA (vs the value
 * the client saw); merge ADDS deltas on both client replay and server, so concurrent
 * increments accumulate instead of LWW-clobbering. Convergent because addition commutes,
 * so no baseVersion is needed. A counter delta over a non-number field is rejected.
 */
export type CounterDelta = { readonly __lfCounter: number };

export function isCounterDelta(value: unknown): value is CounterDelta {
  return (
    typeof value === "object" &&
    value !== null &&
    "__lfCounter" in value &&
    typeof (value as { __lfCounter?: unknown }).__lfCounter === "number"
  );
}

/** The delta that turns `current` into `next` as a counter: `next - current` (absent/
 *  non-number current counts as 0). The app patches with the whole intended number; this
 *  derives the increment so concurrent edits accumulate instead of clobbering. */
export function computeCounterDelta(current: unknown, next: number): number {
  return next - (typeof current === "number" ? current : 0);
}

/** Apply a counter delta: `(current ?? 0) + delta`. Absent/non-number current counts as 0.
 *  Commutative + associative, so applying deltas in any order converges. */
export function applyCounterDelta(current: unknown, delta: number): number {
  return (typeof current === "number" ? current : 0) + delta;
}

/**
 * Timestamp-ordered last-writer-wins for a scalar field (an LWW-register). A field write
 * carries the originating op's logical timestamp + a stable tiebreaker (the clientId); the
 * write with the higher `(ts, tiebreaker)` WINS, deterministically and regardless of the
 * order writes arrive at the server. This fixes the offline-first hazard that plain
 * arrival-order LWW has — an OLDER edit that syncs LATER must NOT overwrite a NEWER one.
 *
 * Provably convergent: `(ts, tiebreaker)` is a total order, so all replicas pick the same
 * winner no matter the apply order. The tiebreaker breaks equal-timestamp ties (lexicographic
 * on the clientId string) so two truly-concurrent writes still resolve deterministically.
 */
export type FieldClock = { readonly ts: number; readonly tiebreaker: string };

/** True if an incoming write `(ts, tiebreaker)` beats the current field clock (absent = wins). */
export function lwwWins(incoming: FieldClock, current: FieldClock | undefined): boolean {
  if (!current) return true;
  if (incoming.ts !== current.ts) return incoming.ts > current.ts;
  return incoming.tiebreaker > current.tiebreaker;
}

/** Stable identity key for a set element. Strings (the common case: ids) key as-is;
 *  anything else by JSON so distinct shapes never collide and types don't alias. */
function keyOf(element: unknown): string {
  return typeof element === "string" ? element : JSON.stringify(element);
}

export function isSetDelta(value: unknown): value is SetDelta {
  return (
    typeof value === "object" &&
    value !== null &&
    "__lfSet" in value &&
    typeof (value as { __lfSet?: unknown }).__lfSet === "object" &&
    (value as { __lfSet?: unknown }).__lfSet !== null
  );
}

/** The delta that turns `current` into `next` as a set: elements in next-not-current are
 *  adds, elements in current-not-next are removes. Order/duplicates in inputs don't matter. */
export function computeSetDelta(current: unknown, next: readonly unknown[]): SetDelta["__lfSet"] {
  const currentArr = Array.isArray(current) ? current : [];
  const currentKeys = new Set(currentArr.map(keyOf));
  const nextKeys = new Set(next.map(keyOf));
  const add = next.filter((el) => !currentKeys.has(keyOf(el)));
  const remove = currentArr.filter((el) => !nextKeys.has(keyOf(el)));
  return { add, remove };
}

/** Apply a set delta to a current value: keep current order, drop removed elements, append
 *  added elements not already present. Deterministic + idempotent (re-applying is a no-op). */
export function applySetDelta(current: unknown, delta: SetDelta["__lfSet"]): unknown[] {
  const removeKeys = new Set(delta.remove.map(keyOf));
  const result: unknown[] = [];
  const seen = new Set<string>();
  for (const el of Array.isArray(current) ? current : []) {
    const k = keyOf(el);
    if (removeKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    result.push(el);
  }
  for (const el of delta.add) {
    const k = keyOf(el);
    if (removeKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    result.push(el);
  }
  return result;
}

/**
 * Merge one patch onto a row: for a field whose patch value is a SetDelta, apply the delta
 * to the current field value (set merge); every other field overwrites (field-level LWW).
 * This is the single shared apply rule used by the client view/replay AND the server.
 */
export function mergePatch<T extends Record<string, unknown>>(current: T, patch: Record<string, unknown>): T {
  const next = { ...current } as Record<string, unknown>;
  for (const [field, value] of Object.entries(patch)) {
    next[field] = isSetDelta(value)
      ? applySetDelta(current[field], value.__lfSet)
      : isCounterDelta(value)
        ? applyCounterDelta(current[field], value.__lfCounter)
        : value;
  }
  return next as T;
}
