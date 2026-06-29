# Prior Art Reading Guide

This project should learn from existing local-first systems without copying their public API blindly.

## Replicache

Read for:

- mutator lifecycle
- pending mutation ordering
- push and pull endpoint contracts
- last mutation id
- rewind and replay
- recovery after tab close

Apply to this project:

- local operations must be durable
- server dedupe must be mandatory
- rebase and replay must be deterministic

## Zero

Read for:

- typed mutator DX
- query manager
- mutator proxy
- client-side reads with server authority
- permission model

Apply to this project:

- function references should feel type-safe
- local query subscriptions should be first class
- server authority must remain explicit

## PowerSync

Read for:

- local database as primary read path
- upload queue
- sync streams
- Convex backend examples
- mobile adapter boundaries

Apply to this project:

- provide storage adapter boundaries early
- avoid making SQL the user-facing mental model for Convex users

## Electric

Read for:

- shape streams
- cursors and offsets
- partial replication
- auth around synced subsets

Apply to this project:

- every query shape must map to a safe server pull scope
- cursor semantics must be explicit and testable

## LiveStore

Read for:

- event logs
- materializers
- local SQLite as primary source for UI

Apply to this project:

- the op log should be event-like
- materialization must be deterministic

## Dexie

Read for:

- IndexedDB migrations
- transaction lifetime rules
- blocked upgrades
- observable queries

Apply to this project:

- storage adapter correctness is a product feature

## RxDB

Read for:

- replication tests
- conflict handlers
- leader election
- storage abstractions

Apply to this project:

- multi-tab behavior must be tested, not assumed

## Automerge and Yjs

Read for:

- CRDT document sync
- offline persistence
- network provider separation
- presence and awareness

Apply to this project:

- rich documents should use CRDT adapters, not basic row conflict policies
