import * as Y from "yjs";

// The glue that lets a Yjs CRDT ride an append-only local-first log.
//
// A Yjs document emits binary "updates" on every change. We store each update as
// ONE insert-only row (base64 string). Yjs updates are commutative + idempotent,
// so rows delivered in any order, at least once, always converge to the same
// document — which is exactly what an append-only, no-conflict row stream gives.

// Isomorphic base64 <-> bytes. The op log serializes values as JSON strings, so
// binary updates travel as base64. A simple per-byte loop (no fromCharCode.apply)
// avoids call-stack limits on large updates.
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Tags updates we applied FROM the row stream so the Y.Doc "update" handler does
// not re-append them as new rows (which would loop forever). Any non-local origin
// value works; a stable symbol is unambiguous.
export const REMOTE_ORIGIN: unique symbol = Symbol("convex-localfirst-remote");

// A compaction snapshot: the entire doc state encoded as ONE update. Applied to a
// fresh Y.Doc it reproduces the full document, so it can replace (subsume) all the
// incremental update rows merged into `doc` so far.
export function makeSnapshot(doc: Y.Doc): string {
  return bytesToBase64(Y.encodeStateAsUpdate(doc));
}

// Apply one base64 update, isolating failures: a single corrupt or incompatible
// row (bad base64, a truncated/garbage update, a future-format update) must NOT
// throw and brick the whole document — skip it and keep the rest. Returns whether
// it applied, so callers can still mark it "seen" and not retry a permanently-bad row.
export function applyUpdateSafe(doc: Y.Doc, base64: string, origin: unknown): boolean {
  try {
    Y.applyUpdate(doc, base64ToBytes(base64), origin);
    return true;
  } catch {
    return false;
  }
}
