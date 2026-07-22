import { expectTypeOf, test } from "vitest";
import type { LocalFirstBatchCall } from "../../src/react";
import { useBatch } from "../../src/react";
import type { LocalCommit } from "../../src/core";

// Type-level proof of useBatch's return typing (DX v4 §5). vitest typecheck mode
// type-checks this file; it never runs.
test("useBatch returns a batch runner whose handle exposes typed .local / .server", () => {
  const batch = useBatch();
  // The runner takes a sync-or-async callback and returns a batch call.
  expectTypeOf(batch).toBeFunction();

  // Default (untyped) group results.
  const call = batch(() => {});
  expectTypeOf(call).toEqualTypeOf<LocalFirstBatchCall<unknown>>();
  expectTypeOf(call.groupId).toEqualTypeOf<string>();
  expectTypeOf(call.local).toEqualTypeOf<Promise<readonly LocalCommit[]>>();
  expectTypeOf(call.server).toEqualTypeOf<Promise<readonly unknown[]>>();
  // Awaiting the handle resolves to the per-op server results array.
  expectTypeOf(call).resolves.toEqualTypeOf<readonly unknown[]>();

  // An async callback is accepted.
  batch(async () => {
    await Promise.resolve();
  });

  // The result element type can be pinned via the type parameter.
  const typed = batch<{ id: string }>(() => {});
  expectTypeOf(typed.server).toEqualTypeOf<Promise<readonly { id: string }[]>>();
});
