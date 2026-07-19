// Internal API surface — NOT part of the public package (I13).
//
// The engine, rebase/replay, the derived view, the DSL metadata contract
// (LF_METADATA_KEY, written by the server DSL), multi-tab leadership,
// and low-level call/name helpers are implementation details: app authors must
// never import them, so they are kept OUT of the package's public entry
// ("convex-localfirst/core"). The React adapter and the server DSL — the only
// legitimate internal consumers — import them from "convex-localfirst/core/internal".
// A type-surface guard test (publicApi.test.ts) asserts none of these leak into the
// public index.
export * from "./engine.js";
export * from "./rebase.js";
export * from "./view.js";
export { LF_METADATA_KEY, type LocalFirstFunctionMeta } from "./collect.js";
export * from "./leadership.js";
export * from "./multiTab.js";
export * from "./ordering.js";
export * from "./setMerge.js";
export { createOpId, createDefaultIdFactory } from "./id.js";
export { openLocalFirstDb, INDEXED_DB_SCHEMA_VERSION } from "./indexedDbStore.js";
export { createLocalFirstMutationCall, createFallbackMutationCall } from "./mutationCall.js";
export { defaultFunctionName } from "./functionName.js";
