/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as comments from "../comments.js";
import type * as docUpdates from "../docUpdates.js";
import type * as documents from "../documents.js";
import type * as issues from "../issues.js";
import type * as labels from "../labels.js";
import type * as localfirst from "../localfirst.js";
import type * as projects from "../projects.js";
import type * as sync from "../sync.js";
import type * as todos from "../todos.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  comments: typeof comments;
  docUpdates: typeof docUpdates;
  documents: typeof documents;
  issues: typeof issues;
  labels: typeof labels;
  localfirst: typeof localfirst;
  projects: typeof projects;
  sync: typeof sync;
  todos: typeof todos;
  workspaces: typeof workspaces;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  convexLocalFirst: import("@convex-localfirst/component/_generated/component.js").ComponentApi<"convexLocalFirst">;
};
