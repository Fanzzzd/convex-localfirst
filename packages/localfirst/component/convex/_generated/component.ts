/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    changes: {
      gc: FunctionReference<
        "mutation",
        "internal",
        { now: number; retentionMs?: number },
        any,
        Name
      >;
      append: FunctionReference<
        "mutation",
        "internal",
        {
          dataJson?: string;
          kind: "insert" | "patch" | "delete";
          localId: string;
          opId?: string;
          patchJson?: string;
          retentionMs?: number;
          scopeKey: string;
          serverId?: string;
          serverTime: number;
          table: string;
          version: number;
        },
        any,
        Name
      >;
      commitOp: FunctionReference<
        "mutation",
        "internal",
        {
          committedAt: number;
          error?: string;
          change?: {
            dataJson?: string;
            kind: "insert" | "patch" | "delete";
            localId: string;
            opId?: string;
            patchJson?: string;
            scopeKey: string;
            serverId?: string;
            serverTime: number;
            table: string;
            version: number;
          };
          opId: string;
          retentionMs?: number;
          schemaVersion: number;
          status: "accepted" | "rejected";
          userId: string;
        },
        any,
        Name
      >;
      firstId: FunctionReference<"query", "internal", { scopeKey: string }, any, Name>;
      lastId: FunctionReference<"query", "internal", { scopeKey: string }, any, Name>;
      latestVersion: FunctionReference<
        "query",
        "internal",
        { localId: string; table: string },
        any,
        Name
      >;
      listAfter: FunctionReference<
        "query",
        "internal",
        { cursor?: string; limit: number; scopeKey: string },
        any,
        Name
      >;
      listVersions: FunctionReference<
        "query",
        "internal",
        { afterRowKey?: string; limit: number; scopeKey: string },
        any,
        Name
      >;
      scopeForLocal: FunctionReference<
        "query",
        "internal",
        { localId: string; table: string },
        any,
        Name
      >;
    };
    idMaps: {
      get: FunctionReference<
        "query",
        "internal",
        { localId: string; table: string },
        any,
        Name
      >;
      put: FunctionReference<
        "mutation",
        "internal",
        { localId: string; serverId: string; table: string; userId: string },
        any,
        Name
      >;
    };
    ops: {
      getByOpId: FunctionReference<
        "query",
        "internal",
        { opId: string; userId: string },
        any,
        Name
      >;
    };
  };
