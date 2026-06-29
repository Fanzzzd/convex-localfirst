// Internal API surface — NOT part of the public package (GOAL §6 / I13).
//
// The engine, rebase/replay, the derived view, the manifest interpreters
// (declarative*, consumed only by codegen output), multi-tab leadership, and
// low-level call/name helpers are implementation details: app authors must never
// import them, so they are kept OUT of the package's public entry
// ("@convex-localfirst/core"). The React adapter and generated code — the only
// legitimate internal consumers — import them from "@convex-localfirst/core/internal".
// A type-surface guard test (publicApi.test.ts) asserts none of these leak into the
// public index.
export * from "./engine.js";
export * from "./rebase.js";
export * from "./view.js";
export * from "./declarative.js";
export * from "./leadership.js";
export * from "./multiTab.js";
export * from "./ordering.js";
export * from "./setMerge.js";
export { createOpId, createDefaultIdFactory } from "./id.js";
export { openLocalFirstDb, INDEXED_DB_SCHEMA_VERSION } from "./indexedDbStore.js";
export { createLocalFirstMutationCall, createFallbackMutationCall } from "./mutationCall.js";
export { defaultFunctionName } from "./functionName.js";
