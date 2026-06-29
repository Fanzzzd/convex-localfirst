import { expectTypeOf, test } from "vitest";
import type { FunctionReference } from "convex/server";
import { defineLocalFirstManifest } from "@convex-localfirst/core";
import { createConvexLocalFirst } from "../src";

// Type-level proof that the headless engine infers mutate/query args + result from the
// function reference — the same inference React's useQuery gives — so headless consumers
// are NOT forced into `<any>`. (vitest typecheck mode type-checks this; it never runs.)
test("createConvexLocalFirst engine: mutate/query infer args + result from the ref", () => {
  const manifest = defineLocalFirstManifest({ schemaVersion: 1, tables: {}, queries: {}, mutations: {} });
  const { engine } = createConvexLocalFirst({ manifest, client: {} as never });

  type CreateTodo = FunctionReference<"mutation", "public", { title: string }, { id: string }>;
  type ListTodos = FunctionReference<"query", "public", { listId: string }, ReadonlyArray<{ title: string }>>;
  const create = {} as CreateTodo;
  const list = {} as ListTodos;

  // result inference: .server resolves to the mutation's declared return type
  expectTypeOf(engine.mutate(create, { title: "x" }).server).resolves.toEqualTypeOf<{ id: string }>();
  // query result inference (| undefined, like useQuery)
  expectTypeOf(engine.query(list, { listId: "a" })).resolves.toEqualTypeOf<
    ReadonlyArray<{ title: string }> | undefined
  >();

  // args are TYPED, not `any`: a wrong arg shape is a compile error (if inference were
  // missing, this @ts-expect-error would itself error because no error would occur).
  // @ts-expect-error wrong arg shape rejected
  engine.mutate(create, { wrong: 1 });
  // @ts-expect-error query args typed too
  engine.query(list, { listId: 123 });
});
