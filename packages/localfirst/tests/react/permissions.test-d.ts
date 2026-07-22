import { expectTypeOf, test } from "vitest";
import { v } from "convex/values";
import { useCan, useRole, useUndo } from "../../src/react";
import { createLocalFirst } from "../../src/server";
import type { ClientCanConfig, TableRowOf } from "../../src/core";

const lf = createLocalFirst();
const scope = lf.byWorkspace({ workspaceIdField: "workspace_id", membershipTable: "members" });

const issues = lf.table("issues", {
  shape: { workspace_id: v.string(), title: v.string(), priority: v.number() },
  scope,
  indexes: { byWorkspace: ["workspace_id"] },
  // The mirror is typed to the row: `before`/`proposed` are the issue row, `patch` its
  // fields. `role` is `unknown` at the table option (annotate/cast to your app role).
  clientCan: {
    write: ({ before, proposed, action }) => {
      expectTypeOf(before).toEqualTypeOf<IssueRow | null>();
      expectTypeOf(proposed).toEqualTypeOf<IssueRow | null>();
      expectTypeOf(action).toEqualTypeOf<"insert" | "patch" | "delete">();
      return true;
    },
  },
});

const modules = { issues: { issues } };
type Modules = typeof modules;
type IssueRow = TableRowOf<Modules, "issues">;

test("useRole is generic over the role type", () => {
  const role = useRole<number>({ workspace_id: "w1" });
  expectTypeOf(role).toEqualTypeOf<number | null | undefined>();
});

test("useCan<Modules> types table names and row shapes from the db root", () => {
  const can = useCan<Modules>();
  const row = {} as IssueRow;
  expectTypeOf(can.patch("issues", row, { title: "x" })).toEqualTypeOf<boolean>();
  expectTypeOf(can.insert("issues", row)).toEqualTypeOf<boolean>();
  expectTypeOf(can.remove("issues", row)).toEqualTypeOf<boolean>();
  // @ts-expect-error — "nope" is not a declared table name.
  can.patch("nope", row);
  // @ts-expect-error — the proposed row must match the table's shape.
  can.insert("issues", { not: "a row" });
});

test("useCan() (untyped) accepts loose string tables", () => {
  const can = useCan();
  expectTypeOf(can.patch("anything", {}, {})).toEqualTypeOf<boolean>();
});

test("ClientCanConfig is generic over Row and Role", () => {
  const mirror: ClientCanConfig<IssueRow, number> = {
    write: ({ role, before, patch }) => {
      expectTypeOf(role).toEqualTypeOf<number>();
      expectTypeOf(before).toEqualTypeOf<IssueRow | null>();
      expectTypeOf(patch).toEqualTypeOf<Record<string, unknown> | undefined>();
      return role >= 15;
    },
  };
  void mirror;
});

test("useUndo returns the operation bundle", () => {
  const u = useUndo({ workspace_id: "w1" });
  expectTypeOf(u.undo).toEqualTypeOf<() => Promise<void>>();
  expectTypeOf(u.canUndo).toEqualTypeOf<boolean>();
  expectTypeOf(u.canRedo).toEqualTypeOf<boolean>();
});
