import { describe, expect, it } from "vitest";
import { MemoryLocalStore, type PushResponse, type SyncTransport } from "../../src/core";
import {
  createMultiTabSync,
  type BroadcastChannelLike,
  type LockManagerLike,
  type TabLeadershipLike
} from "../../src/core/internal";
import type { OperationOutcome } from "../../src/core/internal";
import { createHarness, serverChange } from "./helpers";

/** A BroadcastChannel hub: postMessage reaches every OTHER channel of the same name
 *  (never the sender), like the real API. Delivery is synchronous for test determinism. */
function makeChannelHub() {
  const byName = new Map<string, Set<FakeChannel>>();
  class FakeChannel implements BroadcastChannelLike {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    private readonly peers: Set<FakeChannel>;
    constructor(public readonly name: string) {
      let set = byName.get(name);
      if (!set) {
        set = new Set();
        byName.set(name, set);
      }
      set.add(this);
      this.peers = set;
    }
    postMessage(message: unknown): void {
      for (const ch of this.peers) {
        if (ch !== this) {
          ch.onmessage?.({ data: message });
        }
      }
    }
    close(): void {
      this.peers.delete(this);
    }
  }
  return { create: (name: string) => new FakeChannel(name) };
}

/** A controllable leadership: start() emits the current leadership; setLeader re-emits. */
function makeFakeLeadership(initialLeader = false) {
  const state: { leader: boolean; cb: ((isLeader: boolean) => void) | null } = { leader: initialLeader, cb: null };
  const create = (onChange: (isLeader: boolean) => void): TabLeadershipLike => {
    state.cb = onChange;
    return {
      start: async () => {
        state.cb?.(state.leader);
      },
      stop: () => {},
      isLeader: () => state.leader
    };
  };
  return {
    create,
    setLeader(value: boolean) {
      state.leader = value;
      state.cb?.(value);
    }
  };
}

/** A stub engine whose pokeLocalChange fires its data listeners — exactly like the real
 *  store.notify — so echo-suppression and re-read are testable without IndexedDB. */
function makeStubEngine() {
  const listeners = new Set<() => void>();
  const outcomeListeners = new Set<(outcome: OperationOutcome) => void>();
  return {
    enabled: true,
    multiTab: false,
    pokes: 0,
    flushes: 0,
    setSyncEnabled(enabled: boolean) {
      this.enabled = enabled;
    },
    setMultiTabEnabled(enabled: boolean) {
      this.multiTab = enabled;
    },
    pokeLocalChange() {
      this.pokes++;
      for (const l of Array.from(listeners)) l();
    },
    flushPending() {
      this.flushes++;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeOperationOutcomes(listener: (outcome: OperationOutcome) => void) {
      outcomeListeners.add(listener);
      return () => outcomeListeners.delete(listener);
    },
    observeOperationOutcome() {},
    /** Simulate a genuine local store change (what enqueue/applyServerChanges trigger). */
    fireChange() {
      for (const l of Array.from(listeners)) l();
    }
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeLockManager(): LockManagerLike {
  type Entry = {
    signal?: AbortSignal;
    callback: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  };
  const queues = new Map<string, Entry[]>();
  const held = new Set<string>();
  const drain = (name: string) => {
    if (held.has(name)) return;
    const queue = queues.get(name);
    const entry = queue?.shift();
    if (!entry) return;
    if (entry.signal?.aborted) {
      entry.reject(new DOMException("aborted", "AbortError"));
      drain(name);
      return;
    }
    held.add(name);
    void entry.callback().then(
      (value) => entry.resolve(value),
      (error) => entry.reject(error)
    ).finally(() => {
      held.delete(name);
      drain(name);
    });
  };
  return {
    request(name, options, callback) {
      return new Promise((resolve, reject) => {
        const entry = { signal: options.signal, callback, resolve, reject };
        let queue = queues.get(name);
        if (!queue) {
          queue = [];
          queues.set(name, queue);
        }
        queue.push(entry);
        options.signal?.addEventListener("abort", () => {
          const index = queue!.indexOf(entry);
          if (index >= 0) {
            queue!.splice(index, 1);
            reject(new DOMException("aborted", "AbortError"));
          }
        }, { once: true });
        drain(name);
      });
    }
  };
}

describe("createMultiTabSync — leadership gate", () => {
  it("disables sync for a follower and enables it for a leader (via onChange)", async () => {
    const hub = makeChannelHub();
    const lead = makeFakeLeadership(false);
    const engine = makeStubEngine();
    const dispose = createMultiTabSync(engine, {
      name: "u:user_a",
      id: "a",
      createChannel: hub.create,
      createLeadership: lead.create
    });
    expect(engine.enabled).toBe(false); // start() emitted follower

    lead.setLeader(true);
    expect(engine.enabled).toBe(true);

    dispose();
    expect(engine.enabled).toBe(true); // restored to the un-gated default
  });

  it("gates a tab that is a follower from the start (no onChange(false) ever fires)", async () => {
    // The real TabLeadership fires onChange(true) only when a tab BECOMES leader; a tab
    // that merely starts as a follower (queued Web Locks waiter / election loser) gets NO
    // onChange. The coordinator must still gate it up front, or the follower keeps the
    // engine's default syncEnabled=true and runs the background push (the bug R12 fixed).
    const hub = makeChannelHub();
    const engine = makeStubEngine();
    const silentLeadership: TabLeadershipLike = {
      start: async () => {}, // never promoted → never calls onChange
      stop: () => {},
      isLeader: () => false
    };
    const dispose = createMultiTabSync(engine, {
      name: "u:user_a",
      id: "follower",
      createChannel: hub.create,
      createLeadership: () => silentLeadership
    });

    expect(engine.enabled).toBe(false); // gated despite no onChange

    dispose();
    expect(engine.enabled).toBe(true);
  });
});

describe("createMultiTabSync — cross-tab poke", () => {
  it("a local change in one tab pokes the others to re-read", async () => {
    const hub = makeChannelHub();
    const a = makeStubEngine();
    const b = makeStubEngine();
    const disposeA = createMultiTabSync(a, {
      name: "u:user_a",
      id: "a",
      createChannel: hub.create,
      createLeadership: makeFakeLeadership(true).create
    });
    const disposeB = createMultiTabSync(b, {
      name: "u:user_a",
      id: "b",
      createChannel: hub.create,
      createLeadership: makeFakeLeadership(false).create
    });

    a.fireChange();
    await flush();

    expect(b.pokes).toBe(1); // B re-read after A's change
    expect(a.pokes).toBe(0); // A did not poke itself (no echo back from B)

    disposeA();
    disposeB();
  });

  it("does NOT ping-pong: a received poke never re-broadcasts (echo suppression)", async () => {
    const hub = makeChannelHub();
    const a = makeStubEngine();
    const b = makeStubEngine();
    const disposeA = createMultiTabSync(a, {
      name: "u:user_a",
      id: "a",
      createChannel: hub.create,
      createLeadership: makeFakeLeadership(true).create
    });
    const disposeB = createMultiTabSync(b, {
      name: "u:user_a",
      id: "b",
      createChannel: hub.create,
      createLeadership: makeFakeLeadership(false).create
    });

    a.fireChange();
    await flush();
    await flush(); // give any echo a chance to (not) appear

    expect(b.pokes).toBe(1);
    expect(a.pokes).toBe(0); // would grow unboundedly if echoes weren't suppressed

    disposeA();
    disposeB();
  });

  it("the leader drains a follower's durable change", async () => {
    const hub = makeChannelHub();
    const leader = makeStubEngine();
    const follower = makeStubEngine();
    const disposeLeader = createMultiTabSync(leader, {
      name: "u:user_a",
      id: "a",
      createChannel: hub.create,
      createLeadership: makeFakeLeadership(true).create
    });
    const disposeFollower = createMultiTabSync(follower, {
      name: "u:user_a",
      id: "b",
      createChannel: hub.create,
      createLeadership: makeFakeLeadership(false).create
    });

    follower.fireChange(); // a write happened in the follower tab
    await flush();

    expect(leader.pokes).toBe(1); // leader re-reads the shared store (freshness)
    expect(leader.flushes).toBe(1);
    expect(follower.flushes).toBe(0);

    disposeLeader();
    disposeFollower();
  });

  it("isolates by name: tabs of a different user do not poke each other", async () => {
    const hub = makeChannelHub();
    const a = makeStubEngine();
    const other = makeStubEngine();
    const disposeA = createMultiTabSync(a, {
      name: "u:user_a",
      id: "a",
      createChannel: hub.create,
      createLeadership: makeFakeLeadership(true).create
    });
    const disposeOther = createMultiTabSync(other, {
      name: "u:user_b",
      id: "x",
      createChannel: hub.create,
      createLeadership: makeFakeLeadership(true).create
    });

    a.fireChange();
    await flush();

    expect(other.pokes).toBe(0); // different coordination name → different channel

    disposeA();
    disposeOther();
  });
});

describe("createMultiTabSync — real shared outbox", () => {
  it("only the leader pushes and an insert cannot be overtaken by a cross-tab delete", async () => {
    const hub = makeChannelHub();
    const locks = makeLockManager();
    const store = new MemoryLocalStore();
    const serverRows = new Set<string>();
    const pushClients: string[] = [];
    let version = 0;
    const transport: SyncTransport = {
      async push(request): Promise<PushResponse> {
        pushClients.push(request.clientId);
        const accepted: PushResponse["accepted"] = [];
        const rejected: PushResponse["rejected"] = [];
        const changes = [];
        for (const op of request.mutations) {
          if (op.kind === "insert") {
            serverRows.add(op.id);
            accepted.push({ opId: op.opId, serverResult: { ok: true } });
            changes.push(serverChange({ id: op.id, kind: "insert", version: ++version, value: op.value, opId: op.opId }));
          } else if (op.kind === "delete" && serverRows.has(op.id)) {
            serverRows.delete(op.id);
            accepted.push({ opId: op.opId, serverResult: { ok: true } });
            changes.push(serverChange({ id: op.id, kind: "delete", version: ++version, opId: op.opId }));
          } else {
            rejected.push({ opId: op.opId, message: "delete arrived before insert" });
          }
        }
        return { accepted, rejected, idMaps: [], changes, serverTime: version };
      },
      async pull() {
        return { changes: [], cursors: {}, serverTime: version };
      }
    };
    const leader = createHarness({ store, transport, clientId: "leader", clock: () => 500, syncTimeoutMs: 1000 }).engine;
    const follower = createHarness({ store, transport, clientId: "follower", clock: () => 1000, syncTimeoutMs: 1000 }).engine;
    const disposeLeader = createMultiTabSync(leader, { name: "shared", id: "leader", createChannel: hub.create, locks });
    const disposeFollower = createMultiTabSync(follower, { name: "shared", id: "follower", createChannel: hub.create, locks });

    const insert = follower.mutate("todos:create", { localId: "t1", listId: "i", text: "x" });
    await insert.local;
    const remove = leader.mutate("todos:remove", { id: "t1" });
    await Promise.all([insert.server, remove.server]);

    expect(pushClients.length).toBeGreaterThan(0);
    expect(new Set(pushClients)).toEqual(new Set(["leader"]));
    expect(serverRows.has("t1")).toBe(false);
    expect(await leader.tableRows("todos")).toEqual([]);
    disposeLeader();
    disposeFollower();
  });

  it("promotes a follower and ledger-replays a shared op when the leader dies mid-push", async () => {
    const hub = makeChannelHub();
    const locks = makeLockManager();
    const store = new MemoryLocalStore();
    const pushes: string[] = [];
    const transport: SyncTransport = {
      async push(request) {
        pushes.push(request.clientId);
        if (request.clientId === "leader") return new Promise<PushResponse>(() => {});
        const op = request.mutations[0]!;
        return {
          accepted: [{ opId: op.opId, serverResult: { ok: true, replayed: true } }], rejected: [], idMaps: [],
          changes: [serverChange({ id: op.id, kind: "insert", version: 1, value: op.value, opId: op.opId })], serverTime: 1
        };
      },
      async pull() {
        return { changes: [], cursors: {}, serverTime: 1 };
      }
    };
    const leader = createHarness({ store, transport, clientId: "leader", syncTimeoutMs: 1000 }).engine;
    const follower = createHarness({ store, transport, clientId: "follower", syncTimeoutMs: 1000 }).engine;
    const disposeLeader = createMultiTabSync(leader, { name: "death", id: "leader", createChannel: hub.create, locks });
    const disposeFollower = createMultiTabSync(follower, { name: "death", id: "follower", createChannel: hub.create, locks });
    const call = follower.mutate("todos:create", { localId: "t1", listId: "i", text: "survives" });
    await call.local;
    while (!pushes.includes("leader")) await flush();

    disposeLeader();
    while (!pushes.includes("follower")) await flush();
    await expect(call.server).resolves.toMatchObject({ replayed: true });
    expect(pushes.slice(0, 2)).toEqual(["leader", "follower"]);
    expect((await store.getRows("todos"))[0]).toMatchObject({ _id: "t1", text: "survives" });
    disposeFollower();
  });
});
