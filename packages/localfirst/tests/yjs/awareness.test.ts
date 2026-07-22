import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createDocAwareness, type AwarenessPeer } from "../../src/yjs/awareness.js";

// Awareness rides the presence transport as opaque payloads. These tests exercise the
// headless core (createDocAwareness) by hand-relaying payloads between two clients —
// exactly what useDocAwareness does over usePresence, minus React/Convex.

const peer = (clientId: string, broadcast: { ac: number; aw: string }): AwarenessPeer => ({
  clientId,
  data: { doc: "d1", ...broadcast },
});

describe("createDocAwareness", () => {
  it("relays one client's cursor state to another", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = createDocAwareness(docA, { state: { user: { name: "Ada", color: "#f00" } } });
    const b = createDocAwareness(docB);

    // A broadcasts, B receives.
    b.applyPeers([peer("a", a.localBroadcast())]);

    const remote = [...b.awareness.getStates().entries()].find(
      ([id]) => id !== b.awareness.clientID,
    );
    expect(remote?.[1]).toMatchObject({ user: { name: "Ada", color: "#f00" } });
    a.destroy();
    b.destroy();
  });

  it("broadcasts again when the local state changes", () => {
    const doc = new Y.Doc();
    const broadcasts: number[] = [];
    const a = createDocAwareness(doc, { onBroadcast: () => broadcasts.push(1) });
    a.setLocalStateField("cursor", { anchor: 3, head: 5 });
    a.setLocalStateField("cursor", { anchor: 4, head: 4 });
    expect(broadcasts.length).toBeGreaterThanOrEqual(2);
    a.destroy();
  });

  it("does not echo a peer's own state back to itself", () => {
    const doc = new Y.Doc();
    const emitted: unknown[] = [];
    const a = createDocAwareness(doc, { onBroadcast: (p) => emitted.push(p) });
    // A peer whose ac equals ours must be ignored (no state change, no re-broadcast).
    a.applyPeers([peer("self", { ac: a.awareness.clientID, aw: "" })]);
    expect(emitted).toHaveLength(0);
    a.destroy();
  });

  it("drops a peer's cursor when that peer leaves (no longer present)", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = createDocAwareness(docA, { state: { user: { name: "Ada" } } });
    const b = createDocAwareness(docB);

    b.applyPeers([peer("a", a.localBroadcast())]);
    expect(b.awareness.getStates().size).toBe(2); // self + A

    b.applyPeers([]); // A is gone from the presence list
    expect(b.awareness.getStates().has(a.awareness.clientID)).toBe(false);
    a.destroy();
    b.destroy();
  });

  it("survives a corrupt peer payload without throwing", () => {
    const doc = new Y.Doc();
    const b = createDocAwareness(doc);
    expect(() => b.applyPeers([peer("bad", { ac: 999, aw: "!!!not base64!!!" })])).not.toThrow();
    b.destroy();
  });
});
