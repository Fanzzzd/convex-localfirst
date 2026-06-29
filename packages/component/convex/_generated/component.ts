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
      append: FunctionReference<
        "mutation",
        "internal",
        {
          dataJson?: string;
          kind: "insert" | "patch" | "delete";
          localId: string;
          opId?: string;
          patchJson?: string;
          scopeKey: string;
          serverTime: number;
          table: string;
          version: number;
        },
        any,
        Name
      >;
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
      scopeForLocal: FunctionReference<
        "query",
        "internal",
        { localId: string; table: string },
        any,
        Name
      >;
    };
    fieldClocks: {
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
        { clocksJson: string; localId: string; table: string },
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
      record: FunctionReference<
        "mutation",
        "internal",
        {
          argsJson: string;
          changesJson?: string;
          clientId: string;
          committedAt: number;
          error?: string;
          functionName: string;
          localId: string;
          opId: string;
          operationJson: string;
          resultJson?: string;
          schemaVersion: number;
          status: "accepted" | "rejected";
          table: string;
          userId: string;
        },
        any,
        Name
      >;
    };
  };
