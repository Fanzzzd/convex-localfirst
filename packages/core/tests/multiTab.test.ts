import { describe, expect, it } from "vitest";
import { createMultiTabSync, type BroadcastChannelLike, type TabLeadershipLike } from "../src/internal";

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
  return {
    enabled: true,
    pokes: 0,
    flushes: 0,
    setSyncEnabled(enabled: boolean) {
      this.enabled = enabled;
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
    /** Simulate a genuine local store change (what enqueue/applyServerChanges trigger). */
    fireChange() {
      for (const l of Array.from(listeners)) l();
    }
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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

  it("the LEADER does NOT re-push on a follower's change — it only pokes (no double-push race)", async () => {
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
    // The leader must NOT re-push the follower's op: the follower pushes its OWN
    // mutations, so a leader re-push would double-push the same opId concurrently.
    expect(leader.flushes).toBe(0);
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
