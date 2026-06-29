# Test Matrix

## DX tests

- explicit import mode
- alias mode
- fallback query
- fallback mutation
- local-first query detection
- local-first mutation detection
- query initial value
- hybrid mutation promise
- sync status hook
- query meta hook

## Engine tests

- insert local row
- patch local row
- delete local row
- enqueue op
- ack op
- reject op
- duplicate op
- pull insert change
- pull patch change
- pull delete change
- rebase with pending patch
- rebase with pending delete
- schema mismatch

## Store tests

- get and put row
- transaction commit
- transaction rollback
- persist outbox
- persist cursor
- namespace isolation
- migration success
- migration blocked
- broadcast notification

## Sync tests

- push accepted op
- push duplicate op
- push rejected op
- push network failure
- retry backoff
- pull empty cursor
- pull existing cursor
- pull multiple scopes
- pull tombstones
- id map application

## Security tests

- by user accepts own row
- by user rejects other row
- by workspace member can pull
- by workspace non-member cannot pull
- direct write checker catches local-first table write
- server-only function not queued
- client owner id spoof rejected

## Component tests

- record client
- dedupe operation
- append change
- advance cursor
- read changes by scope
- id map lookup
- tombstone retention

## Example tests

- todo offline insert
- todo reload with pending op
- todo push after reconnect
- todo second client pull
- todo duplicate push
- todo conflict display
