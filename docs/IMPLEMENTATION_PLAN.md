# Implementation Plan

## Phase 1: Core correctness

Build the core engine with a memory store.

Deliverables:

- `LocalFirstEngine`
- `MemoryLocalStore`
- `LocalOperation` model
- `ServerChange` model
- `MutationStatusTracker`
- `createLocalFirstMutationCall`
- deterministic rebase and replay
- tests for local writes, duplicate ops, rejection, pull, tombstones, and rebase

## Phase 2: Durable web storage

Build the IndexedDB adapter.

Deliverables:

- object stores for rows, canonical rows, outbox, cursors, metadata, id maps, and conflicts
- schema migrations
- transaction wrappers
- blocked upgrade reporting
- namespace isolation by deployment, user, and schema version
- storage tests

## Phase 3: React integration

Build the wrapper hooks.

Deliverables:

- `ConvexReactClient`
- `ConvexProvider`
- `LocalFirstProvider`
- `useQuery`
- `useMutation`
- `useSyncStatus`
- `useQueryMeta`
- fallback to official Convex hooks
- React tests with a fake transport

## Phase 4: Server DSL

Build the public authoring API.

Deliverables:

- `createLocalFirst`
- `lf.table`
- `table.query`
- `table.insert`
- `table.patch`
- `table.remove`
- scope declarations
- conflict declarations
- server-only escape hatch
- metadata extraction for codegen

## Phase 5: Codegen and check

Build the developer workflow.

Deliverables:

- `convex-localfirst init`
- `convex-localfirst dev`
- `convex-localfirst codegen`
- `convex-localfirst check`
- generated client manifest
- generated Convex sync functions
- generated type helpers
- direct-write checker for local-first tables

## Phase 6: Convex Component

Build component-backed metadata and idempotency.

Deliverables:

- clients table
- operation ledger
- change log
- cursors
- id map
- tombstones
- helper functions for record, dedupe, append, pull
- component tests with a Convex test harness

## Phase 7: Multi-tab and recovery

Deliverables:

- Web Locks leadership
- BroadcastChannel invalidation
- crash recovery for abandoned pending ops
- retry with backoff
- online and offline detection
- tests for two tabs and tab close recovery

## Phase 8: Advanced coverage

Deliverables:

- `byWorkspace` scope
- custom conflict resolver
- counter conflict policy
- devtools panel
- React Native SQLite adapter interface
- Automerge and Yjs document adapters

## Phase 9: Polish

Deliverables:

- examples
- docs
- migration guide
- warnings with clear fixes
- benchmarks
- package exports
- CI
