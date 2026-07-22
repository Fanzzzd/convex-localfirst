import { expectTypeOf, test } from "vitest";
import { v } from "convex/values";
import { collection, createLocalDb } from "../../src/core";
import { useLiveCounts, useLiveQuery } from "../../src/react";
import { createLocalFirst } from "../../src/server";

const lf = createLocalFirst();
const scope = lf.byWorkspace({ workspaceIdField: "workspaceId", membershipTable: "members" });

const states = lf.table("states", {
  shape: { workspaceId: v.string(), name: v.string() },
  scope
});
const labels = lf.table("labels", {
  shape: { workspaceId: v.string(), name: v.string() },
  scope
});
const issues = lf.table("issues", {
  shape: {
    workspaceId: v.string(),
    title: v.string(),
    priority: v.number(),
    stateId: v.optional(v.string()),
    labelIds: v.array(v.string())
  },
  scope,
  relations: {
    state: lf.one("states", "stateId"),
    labels: lf.many("labels", { via: "labelIds" }),
    subIssues: lf.backref("issues", "parentId")
  }
});

const db = createLocalDb({ issues: { issues }, states: { states }, labels: { labels } });

test("createLocalDb infers rows, scopes, fields, and declared relation results", () => {
  const plan = db.issues
    .scope({ workspaceId: "w1" })
    .filter({ priority: 1 })
    .where("title", "Bug")
    .where((row) => row.priority > 0)
    .orderBy("priority", "desc")
    .with("state", "labels");
  const rows = useLiveQuery(plan);

  type StateRow = {
    workspaceId: string;
    name: string;
    localId: string;
    _id: string;
    _creationTime: number;
  };
  type LabelRow = StateRow;
  type IssueRow = {
    workspaceId: string;
    title: string;
    priority: number;
    stateId?: string;
    labelIds: string[];
    localId: string;
    _id: string;
    _creationTime: number;
  };
  expectTypeOf(rows).toEqualTypeOf<
    Array<IssueRow & { state: StateRow | null; labels: LabelRow[] }> | undefined
  >();

  type IsAny<Value> = 0 extends 1 & Value ? true : false;
  type ResultRow = NonNullable<typeof rows>[number];
  expectTypeOf<IsAny<ResultRow>>().toEqualTypeOf<false>();

  // @ts-expect-error unknown relation name
  db.issues.with("project");
  // @ts-expect-error only the declared scope key is accepted
  db.issues.scope({ workspace: "w1" });
  // @ts-expect-error scope value follows the shape validator
  db.issues.scope({ workspaceId: 1 });
  // @ts-expect-error ordering is limited to shape fields
  db.issues.orderBy("missing");
  // @ts-expect-error field equality uses the field's inferred value type
  db.issues.where("priority", "high");
  // @ts-expect-error filters reject fields outside the shape
  db.issues.filter({ missing: true });
  db.issues.filter({
    priority: { in: [1, 2], gte: 1 },
    labelIds: { contains: "bug", overlaps: ["urgent"] },
    OR: [{ stateId: { eq: "open" } }, { NOT: { title: "Archived" } }]
  });
  // @ts-expect-error scalar fields do not support array membership operators
  db.issues.filter({ priority: { contains: 1 } });
  // @ts-expect-error operator operands follow the field type
  db.issues.filter({ priority: { lt: "high" } });
  // @ts-expect-error unknown operators are rejected
  db.issues.filter({ title: { startsWith: "B" } });

  const groupedPlan = db.issues.scope({ workspaceId: "w1" }).groupBy("stateId").orderBy("priority");
  expectTypeOf(useLiveQuery(groupedPlan)).toEqualTypeOf<
    ReadonlyMap<string | null, IssueRow[]> | undefined
  >();
  expectTypeOf(useLiveCounts(groupedPlan)).toEqualTypeOf<Record<string, number> | undefined>();
  expectTypeOf(useLiveCounts(db.issues.scope({ workspaceId: "w1" }))).toEqualTypeOf<number | undefined>();
  // @ts-expect-error grouping is limited to declared shape fields
  db.issues.groupBy("missing");

  const untyped = collection<{ stateId: string | null; priority: number; labelIds: string[] }>("issues")
    .filter({ priority: { gte: 1 }, labelIds: { contains: "bug" } })
    .groupBy("stateId");
  expectTypeOf(useLiveQuery(untyped)).toEqualTypeOf<
    ReadonlyMap<string | null, Array<{ stateId: string | null; priority: number; labelIds: string[] }>> | undefined
  >();
  // @ts-expect-error untyped collection filters still follow their declared Row generic
  collection<{ priority: number }>("issues").filter({ priority: { in: ["high"] } });
});
