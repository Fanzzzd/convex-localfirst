// Public API surface. Rebase/replay, the derived view, and other
// implementation internals are intentionally NOT re-exported here — they live in
// "./internal.js" ("@convex-localfirst/core/internal") for the React adapter only.
// Keeping them out keeps the public type surface free of internal vocabulary (I13)
// so internals can be rewritten without a semver break. publicApi.test.ts guards this.
//
// The engine is exposed as a HEADLESS factory only (createLocalFirstEngine) + its
// instance TYPE — the class constructor stays internal, so the construction path is
// one blessed function, but imperative/vanilla consumers (a service layer, a MobX
// store, a worker) can build and drive an engine without React. This is what lets a
// real app adopt the library without rewriting its components into hooks.
export { createLocalFirstEngine } from "./engine.js";
export type { LocalFirstEngine, LocalFirstEngineOptions } from "./engine.js";
export * from "./collection.js";
export * from "./relations.js";
// id: only createClientId is a wiring helper. createOpId/createDefaultIdFactory
// are engine internals → "./internal.js".
export { createClientId, type IdFactory } from "./id.js";
// indexedDbStore: IndexedDbStore is the wiring helper. openLocalFirstDb +
// the schema-version constant are internals → "./internal.js".
export { IndexedDbStore, type IndexedDbStoreOptions } from "./indexedDbStore.js";
export * from "./manifest.js";
export * from "./memoryStore.js";
export type { LocalFirstMutationCall } from "./mutationCall.js";
export type { FunctionNameResolver } from "./functionName.js";
// ordering (compareOperations) is an engine internal → "./internal.js".
export * from "./status.js";
export * from "./storage.js";
export * from "./transport.js";
export * from "./types.js";
