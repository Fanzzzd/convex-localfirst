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
import type * as cycles from "../cycles.js";
import type * as issue_activities from "../issue_activities.js";
import type * as issues from "../issues.js";
import type * as labels from "../labels.js";
import type * as localfirst from "../localfirst.js";
import type * as modules from "../modules.js";
import type * as projects from "../projects.js";
import type * as states from "../states.js";
import type * as sync from "../sync.js";
import type * as views from "../views.js";
import type * as whoami from "../whoami.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  comments: typeof comments;
  cycles: typeof cycles;
  issue_activities: typeof issue_activities;
  issues: typeof issues;
  labels: typeof labels;
  localfirst: typeof localfirst;
  modules: typeof modules;
  projects: typeof projects;
  states: typeof states;
  sync: typeof sync;
  views: typeof views;
  whoami: typeof whoami;
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
  convexLocalFirst: import("convex-localfirst/component/_generated/component.js").ComponentApi<"convexLocalFirst">;
};
