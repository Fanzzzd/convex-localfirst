import { IndexedDbStore } from "./indexedDbStore.js";
import { TabLeadership, type LockManagerLike } from "./leadership.js";
import type { LocalStore } from "./storage.js";
import type { OperationOutcome } from "./engine.js";

/** The slice of BroadcastChannel the cross-tab poke channel uses. */
export type BroadcastChannelLike = {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

/**
 * Multi-tab sync coordination. Two independent jobs over one BroadcastChannel:
 *
 *  1. Leadership gate — elect a single leader among the tabs sharing this user's
 *     local data; only the leader pushes. Follower mutations durably enqueue, wake
 *     the leader, and settle from the leader's outcome broadcast.
 *
 *  2. Cross-tab data poke — IndexedDB has no cross-tab change event, so whenever a
 *     tab applies changes to the shared DB it broadcasts "changed"; the others
 *     re-derive their mounted queries (pokeLocalChange).
 *
 * Pull/watch stay per-tab so tabs with different mounted scopes remain fresh; the
 * single-writer invariant applies to pushes.
 */

/** The slice of the engine the coordinator drives (keeps it unit-testable). */
export type MultiTabEngine = {
  setSyncEnabled(enabled: boolean): void;
  setMultiTabEnabled(enabled: boolean): void;
  pokeLocalChange(): void;
  flushPending(): void;
  subscribe(listener: () => void): () => void;
  subscribeOperationOutcomes(listener: (outcome: OperationOutcome) => void): () => void;
  observeOperationOutcome(outcome: OperationOutcome): void;
};

/** The slice of TabLeadership the coordinator drives (so tests can inject a fake). */
export type TabLeadershipLike = {
  start(): Promise<void>;
  stop(): void;
  isLeader(): boolean;
};

export type MultiTabSyncOptions = {
  /** Coordination boundary — tabs sharing the SAME local data (deployment + user) must
   *  share this name and no others. The provider derives it from the authed user. */
  readonly name: string;
  /** Stable id for this tab (the engine's clientId). */
  readonly id: string;
  /** Injected for tests; defaults to a real BroadcastChannel. */
  readonly createChannel?: (name: string) => BroadcastChannelLike;
  /** Injected for tests; defaults to a real TabLeadership over the same lock name. */
  readonly createLeadership?: (onChange: (isLeader: boolean) => void) => TabLeadershipLike;
  /** Passed through to the default TabLeadership (Web Locks manager; null → this tab self-leads). */
  readonly locks?: LockManagerLike | null;
};

type PokeMessage = { readonly type: "changed" } | { readonly type: "outcome"; readonly outcome: OperationOutcome };

/**
 * The multi-tab coordination key for a store. It MUST equal the shared-data boundary so
 * tabs over the SAME data elect one leader, and tabs over DIFFERENT data (a second
 * deployment on one origin, or a different user) never elect a shared leader that can't
 * drain the other's outbox. An IndexedDbStore's (databaseName, namespace) IS that
 * partition (Rule 7: namespaced by deployment + authenticated user). Non-IndexedDb
 * stores are per-instance (not shared across tabs), so the user id is a safe fallback.
 * JSON-encoded so a ':' inside any segment can't merge two distinct boundaries into one.
 */
export function coordinationName(store: LocalStore | undefined, userId: string | null): string {
  if (store instanceof IndexedDbStore) {
    return `idb:${JSON.stringify([store.options.databaseName, store.options.namespace])}`;
  }
  return `user:${JSON.stringify(userId ?? "anon")}`;
}

/**
 * Wire one engine into multi-tab coordination. Returns a dispose that tears down the
 * channel + leadership and restores the engine to the un-gated (every-tab-sync) default.
 */
export function createMultiTabSync(engine: MultiTabEngine, options: MultiTabSyncOptions): () => void {
  const channelName = `convex-localfirst:multitab:${options.name}`;
  const channelFactory =
    options.createChannel ?? ((name) => new BroadcastChannel(name) as unknown as BroadcastChannelLike);
  const channel = channelFactory(channelName);

  let stopped = false;
  // Echo suppression: a received poke fires the store's listeners; without this flag
  // that local notify would re-broadcast, ping-ponging "changed" between tabs forever.
  let applyingPoke = false;
  let broadcastQueued = false;

  // 1) Leadership gates the background push.
  const leadershipFactory =
    options.createLeadership ??
    ((onChange) =>
      new TabLeadership({
        name: channelName,
        id: options.id,
        locks: options.locks,
        onChange
      }));
  const leadership = leadershipFactory((isLeader) => {
    if (!stopped) {
      engine.setSyncEnabled(isLeader);
    }
  });
  engine.setMultiTabEnabled(true);
  // Gate EVERY tab up front, then let leadership re-enable only the actual leader.
  // TabLeadership fires onChange(true) when a tab BECOMES leader but never fires
  // onChange(false) for a tab that merely starts as a follower (a queued Web Locks
  // waiter that begins non-leader and only transitions if the holder releases).
  // Without this, a follower keeps the engine's default syncEnabled=true and still runs
  // the background batch push — defeating the single-leader invariant. setSyncEnabled is
  // idempotent, and the leader's onChange(true) flips it back on.
  engine.setSyncEnabled(false);

  // 2) Cross-tab data poke + leader drain + explicit operation outcome.
  channel.onmessage = (event) => {
    if (stopped) {
      return;
    }
    const data = event.data as PokeMessage | null;
    if (data?.type === "outcome") {
      engine.observeOperationOutcome(data.outcome);
      return;
    }
    if (data?.type !== "changed") {
      return;
    }
    applyingPoke = true;
    try {
      engine.pokeLocalChange();
      if (leadership.isLeader()) engine.flushPending();
    } finally {
      applyingPoke = false;
    }
  };

  const unsubscribe = engine.subscribe(() => {
    if (stopped || applyingPoke || broadcastQueued) {
      return;
    }
    // Coalesce a burst of writes into ONE cross-tab poke per microtask.
    broadcastQueued = true;
    queueMicrotask(() => {
      broadcastQueued = false;
      if (!stopped) {
        channel.postMessage({ type: "changed" } satisfies PokeMessage);
      }
    });
  });
  const unsubscribeOutcomes = engine.subscribeOperationOutcomes((outcome) => {
    if (!stopped) channel.postMessage({ type: "outcome", outcome } satisfies PokeMessage);
  });

  void leadership.start();

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    unsubscribe();
    unsubscribeOutcomes();
    leadership.stop();
    channel.close();
    engine.setMultiTabEnabled(false);
    // A follower's engine was gated; restore the default so a remount/HMR isn't stuck off.
    engine.setSyncEnabled(true);
  };
}
