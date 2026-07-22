import { test } from "vitest";
import type { FunctionReference } from "convex/server";
import { useMutation, useQuery } from "../../src/react";

// Type-level proof that useQuery / useMutation mirror convex/react's arg arity
// (OptionalRestArgs / OptionalRestArgsOrSkip): required args are mandatory, empty
// args are omittable. vitest typecheck mode type-checks this; it never runs.
test("useQuery arity: required args mandatory, empty args omittable", () => {
  type ListWithArgs = FunctionReference<"query", "public", { listId: string }, ReadonlyArray<{ title: string }>>;
  type ListNoArgs = FunctionReference<"query", "public", Record<string, never>, ReadonlyArray<{ title: string }>>;
  const listWithArgs = {} as ListWithArgs;
  const listNoArgs = {} as ListNoArgs;

  // (1) required-args query: passing the args compiles.
  useQuery(listWithArgs, { listId: "a" });
  // options still accepted after the args.
  useQuery(listWithArgs, { listId: "a" }, { initial: [], sync: "off" });
  // "skip" is always allowed in place of the args.
  useQuery(listWithArgs, "skip");
  // (2) required-args query: OMITTING the args is a compile error.
  // @ts-expect-error required args must be provided
  useQuery(listWithArgs);
  // wrong arg shape is a compile error too.
  // @ts-expect-error wrong arg type
  useQuery(listWithArgs, { listId: 123 });

  // (3) empty-args query: omitting the args is allowed.
  useQuery(listNoArgs);
  useQuery(listNoArgs, {});
  useQuery(listNoArgs, "skip");
  useQuery(listNoArgs, {}, { initial: [] });
});

test("useMutation arity: required args mandatory, empty args callable with ()", () => {
  type CreateWithArgs = FunctionReference<"mutation", "public", { title: string }, { id: string }>;
  type CreateNoArgs = FunctionReference<"mutation", "public", Record<string, never>, { id: string }>;
  const create = useMutation({} as CreateWithArgs);
  const ping = useMutation({} as CreateNoArgs);

  // (4a) required-args mutation: passing args compiles; .server infers the return type.
  create({ title: "x" });
  // (4b) required-args mutation: calling with NO args is a compile error.
  // @ts-expect-error required args must be provided
  create();
  // wrong arg shape rejected.
  // @ts-expect-error wrong arg type
  create({ title: 123 });

  // (4c) empty-args mutation: callable with () or ({}).
  ping();
  ping({});
});
