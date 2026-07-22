import { v } from "convex/values";
import type { RegisteredMutation } from "convex/server";
import { buildSyncCore, type CreateSyncFunctionsOptions } from "./createSyncFunctions.js";
import { authorizeRowWrite } from "./serverSync.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyCtx = any;

export type CreateAttachmentFunctionsOptions<
  Role = unknown,
  Row extends Record<string, unknown> = Record<string, unknown>
> = CreateSyncFunctionsOptions<Role, Row> & {
  /** The attachment metadata table (must be one of the local-first `tables`). Its
   *  rows sync like any other; `storageIdField` is patched server-side on finalize. */
  readonly table: string;
  /** Field the server stamps with the Convex storage id (default "storageId"). Must
   *  be part of the table's synced shape so clients receive it. */
  readonly storageIdField?: string;
  /** Mint a one-shot upload URL — normally `(ctx) => ctx.storage.generateUploadUrl()`. */
  readonly generateUploadUrl: (ctx: AnyCtx) => Promise<string>;
};

/** The two mutations the client attachment uploader calls. Opaque to app code —
 *  they are driven by the engine's AttachmentManager, not `useMutation`. */
export type AttachmentFunctions = {
  readonly getUploadUrl: RegisteredMutation<"public", Record<string, unknown>, unknown>;
  readonly finalize: RegisteredMutation<"public", Record<string, unknown>, unknown>;
};

/**
 * Compose the server side of the offline attachment pipeline (P5): the `getUploadUrl`
 * and `finalize` mutations the client uploader calls. Both authorize through the SAME
 * access config as `createSyncFunctions` (the caller must be allowed to WRITE the
 * table's row) — attachments never open a weaker authz path — and `finalize` patches
 * the storage id via the trusted serverWriter, so every client syncs it.
 *
 * ```ts
 * export const { getUploadUrl, finalize } = createAttachmentFunctions({
 *   component: components.convexLocalFirst, mutation, query,
 *   tables, access, table: "attachments",
 *   generateUploadUrl: (ctx) => ctx.storage.generateUploadUrl()
 * });
 * ```
 */
export function createAttachmentFunctions<
  Role = unknown,
  Row extends Record<string, unknown> = Record<string, unknown>
>(options: CreateAttachmentFunctionsOptions<Role, Row>): AttachmentFunctions {
  const core = buildSyncCore(options);
  const table = options.table;
  const storageIdField = options.storageIdField ?? "storageId";
  const tableConfig = core.config.tables[table];
  if (!tableConfig) {
    throw new Error(
      `createAttachmentFunctions: "${table}" is not a configured local-first table. Add it to \`tables\` (collectTables).`
    );
  }
  if (tableConfig.syncedFields && !tableConfig.syncedFields.includes(storageIdField)) {
    throw new Error(
      `createAttachmentFunctions: storageIdField "${storageIdField}" must be part of the "${table}" table shape so it syncs to clients.`
    );
  }
  // storageId is SERVER-controlled: it must not be writable by any client mutation
  // (finalize sets it via serverWriter). Fail closed on a misconfiguration.
  for (const [fn, mutation] of Object.entries(tableConfig.mutations ?? {})) {
    if (mutation.kind !== "delete" && mutation.fields.includes(storageIdField)) {
      throw new Error(
        `createAttachmentFunctions: mutation "${fn}" of "${table}" exposes the server-controlled field "${storageIdField}". Omit it from the client insert/patch args.`
      );
    }
  }

  const getUploadUrl = options.mutation({
    args: { table: v.string(), localId: v.string(), userId: v.string() },
    handler: async (ctx: AnyCtx, args: any) => {
      if (args.table !== table) {
        throw new Error(`createAttachmentFunctions: getUploadUrl called for unknown table "${args.table}"`);
      }
      const userId = await core.resolveUserId(ctx, args.userId);
      const authorized = await authorizeRowWrite(core.pushStore(ctx), core.configFor(ctx), userId, table, args.localId, {
        [storageIdField]: null
      });
      if (!authorized) {
        throw new Error("convex-localfirst: not authorized to upload an attachment for this row.");
      }
      return await options.generateUploadUrl(ctx);
    }
  });

  const finalize = options.mutation({
    args: { table: v.string(), localId: v.string(), storageId: v.string(), userId: v.string() },
    handler: async (ctx: AnyCtx, args: any) => {
      if (args.table !== table) {
        throw new Error(`createAttachmentFunctions: finalize called for unknown table "${args.table}"`);
      }
      const userId = await core.resolveUserId(ctx, args.userId);
      const config = core.configFor(ctx);
      const store = core.pushStore(ctx);
      const authorized = await authorizeRowWrite(store, config, userId, table, args.localId, {
        [storageIdField]: args.storageId
      });
      if (!authorized) {
        throw new Error("convex-localfirst: not authorized to finalize this attachment.");
      }
      // Idempotent: a retried finalize after a lost ack must not append a spurious
      // change. If the row already carries this storageId, ack without re-patching.
      const serverId = await store.getServerId(table, args.localId);
      const row = serverId ? await store.getRow(table, serverId) : null;
      if (row && row[storageIdField] === args.storageId) {
        return { ok: true, storageId: args.storageId };
      }
      // Patch storageId through the trusted serverWriter so every client syncs it.
      await core.serverWriter(ctx, userId).patch(table, args.localId, { [storageIdField]: args.storageId });
      return { ok: true, storageId: args.storageId };
    }
  });

  return { getUploadUrl, finalize } as AttachmentFunctions;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
