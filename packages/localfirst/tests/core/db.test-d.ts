import { expectTypeOf, test } from "vitest";
import { v } from "convex/values";
import { createLocalDb } from "../../src/core";
import { useLiveQuery } from "../../src/react";
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
});
