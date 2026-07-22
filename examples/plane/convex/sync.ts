import { collectTables, createAttachmentFunctions, createSyncFunctions } from "convex-localfirst/server";
import { components } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";

// Import the local-first table modules so collectTables can read each one's
// scope/idField/conflict from the SAME lf.table(...) definition the client manifest
// is generated from. No restating scope field names or idField/conflict here — that
// drift (edit one file, forget the other) was a silent footgun. Add a table = add
// one import line below; its config comes along for free.
import * as projects from "./projects";
import * as comments from "./comments";
import * as views from "./views";
import * as activities from "./issue_activities";
import * as states from "./states";
import * as labels from "./labels";
import * as cycles from "./cycles";
import * as modules from "./modules";
import * as issues from "./issues";
import * as docUpdates from "./doc_updates";
import * as attachmentsMod from "./attachments";

const guestCanSee = (userId: string, row: Record<string, unknown> | null) =>
  row !== null &&
  (row.created_by === userId || ((row.assignee_ids as string[] | undefined) ?? []).includes(userId));

// Attachments are a local-first table too, so they must be in the SAME sync config
// (clients sync the metadata rows; finalize's serverWriter writes into it).
const tables = collectTables({
  projects,
  comments,
  views,
  activities,
  states,
  labels,
  cycles,
  modules,
  issues,
  docUpdates,
  attachments: attachmentsMod
});

// Membership (I7): the server decides workspace access. scopeValue is the workspace
// slug/id regardless of which field the table stores it in. All workspace tables
// share ONE membership table (ws_members), so this is a single check. Shared by the
// sync AND attachment functions so both authorize identically.
const access = {
  async member(ctx: any, { userId, scopeValue, membershipTable }: any) {
    const row = await ctx.db
      .query(membershipTable)
      .withIndex("by_user_ws", (q: any) => q.eq("user_id", userId).eq("workspace_id", scopeValue))
      .unique();
    return row?.role ?? null;
  },
  read: (_ctx: any, { userId, role, row }: any) => role >= 10 || (role === 5 && guestCanSee(userId, row)),
  write: (_ctx: any, { userId, role, action, before, proposed }: any) => {
    if (role >= 15) return true; // admin/member
    if (role !== 5) return false; // viewer (10) is read-only
    if (action === "insert") return proposed?.created_by === userId;
    return guestCanSee(userId, before) && (action === "delete" || guestCanSee(userId, proposed));
  }
} as const;

export const { push, pull, gc, serverWriter } = createSyncFunctions<number>({
  component: components.convexLocalFirst,
  mutation,
  internalMutation,
  query,
  tables,
  access,
  onWrite: async (ctx, { table, action, before, after, userId }) => {
    if (table !== "issues" || action !== "patch" || !before || !after) return;
    const field = Object.keys(after).find(
      (key) => !["_id", "_creationTime", "updated_at"].includes(key) && before[key] !== after[key]
    );
    if (!field) return;
    await serverWriter(ctx, userId).insert("issue_activities", {
      workspace: String(after.workspace_id),
      project: String(after.project_id),
      issue: String(after.id),
      actor: userId,
      verb: "updated",
      field,
      old_value: before[field] == null ? null : String(before[field]),
      new_value: after[field] == null ? null : String(after[field]),
      created_by: userId
    });
  },
  // Server-minted per-project issue numbers (PROJ-123). Runs inside the push
  // transaction, so the counter read-modify-write is race-free under Convex OCC.
  serverStamp: {
    issues: {
      fields: ["sequence_id"],
      async stamp(ctx, { value }) {
        const key = `issue_seq:${value.project_id}`;
        const counter = await ctx.db
          .query("counters")
          .withIndex("by_key", (q: any) => q.eq("key", key))
          .unique();
        const next = (counter?.value ?? 0) + 1;
        if (counter) await ctx.db.patch(counter._id, { value: next });
        else await ctx.db.insert("counters", { key, value: next });
        return { sequence_id: next };
      }
    }
  },
  // Local backend has no auth provider; identity comes from the client userId. Dev only.
  devUnsafeAllowClientUserId: true
});

// Offline-capable attachment pipeline (P5): the two mutations the client uploader calls.
// getUploadUrl/finalize authorize through the SAME `access` config as sync (the caller
// must be allowed to WRITE the row), and finalize stamps storageId via serverWriter so
// every client syncs it. The client wires these via the ConvexProvider `attachments` prop.
export const { getUploadUrl, finalize } = createAttachmentFunctions<number>({
  component: components.convexLocalFirst,
  mutation,
  query,
  tables,
  access,
  table: "attachments",
  generateUploadUrl: (ctx) => ctx.storage.generateUploadUrl(),
  devUnsafeAllowClientUserId: true
});
