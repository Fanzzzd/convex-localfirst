import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates
} from "y-protocols/awareness";
import { usePresence } from "../react/index.js";
import { base64ToBytes, bytesToBase64 } from "./yjsSync.js";

// Cursor/selection presence for a collaborative doc, via the standard y-protocols
// `Awareness` (what y-prosemirror's cursor plugin consumes) carried over the package's
// existing presence transport (`usePresence`). Awareness state is ephemeral and never
// touches the sync log — exactly presence semantics.
//
// `createDocAwareness` is transport-agnostic (y-protocols only, no React/Convex):
// broadcast the payload it hands you, feed peer payloads back in, and it maintains the
// shared Awareness. `useDocAwareness` wires that to `usePresence`.

/** Origin tag on remotely-applied awareness so our own broadcast handler doesn't echo. */
const REMOTE_AWARENESS = "convex-localfirst-remote-awareness";

/** What one client broadcasts each beat: its numeric awareness client id (`ac`) and its
 *  base64-encoded awareness state (`aw`). Sending full state each time is idempotent, so
 *  duplicate/out-of-order delivery converges. */
export interface AwarenessBroadcast {
  readonly ac: number;
  readonly aw: string;
}

/** A peer's presence row, as delivered by the presence transport. */
export interface AwarenessPeer {
  readonly clientId: string;
  readonly data: Record<string, unknown>;
}

export interface CreateDocAwarenessOptions {
  /** Initial local awareness state (e.g. `{ user: { name, color } }`). */
  readonly state?: Record<string, unknown> | null;
  /** Called whenever the LOCAL state changes — broadcast this payload to peers. */
  readonly onBroadcast?: (payload: AwarenessBroadcast) => void;
}

export interface DocAwareness {
  /** The y-protocols Awareness — pass to y-prosemirror's `yCursorPlugin(awareness)`. */
  readonly awareness: Awareness;
  /** Replace the local awareness state (triggers a broadcast). */
  setLocalState(state: Record<string, unknown> | null): void;
  /** Set one field of the local awareness state (triggers a broadcast). */
  setLocalStateField(field: string, value: unknown): void;
  /** The current local broadcast payload (send it on your first beat). */
  localBroadcast(): AwarenessBroadcast;
  /** Apply the set of currently-present peers: adopt each peer's awareness and drop any
   *  remote client that is no longer present (a peer that left). */
  applyPeers(peers: readonly AwarenessPeer[]): void;
  /** Clear local state and tear down. */
  destroy(): void;
}

/**
 * Wire a y-protocols `Awareness` to any presence transport. Headless: it never imports
 * React or Convex, so it is fully unit-testable by exchanging payloads between two
 * instances.
 */
export function createDocAwareness(doc: Y.Doc, options: CreateDocAwarenessOptions = {}): DocAwareness {
  const awareness = new Awareness(doc);
  if (options.state !== undefined) awareness.setLocalState(options.state);

  const localBroadcast = (): AwarenessBroadcast => ({
    ac: awareness.clientID,
    aw: bytesToBase64(encodeAwarenessUpdate(awareness, [awareness.clientID]))
  });

  // Broadcast on every LOCAL change; remote-applied changes carry REMOTE_AWARENESS origin
  // and are skipped so we don't loop peers' state back to them.
  const onUpdate = (_changes: unknown, origin: unknown) => {
    if (origin === REMOTE_AWARENESS) return;
    options.onBroadcast?.(localBroadcast());
  };
  awareness.on("update", onUpdate);

  // Remote awareness client ids we've adopted, so we can prune the ones that leave.
  const knownRemote = new Set<number>();

  return {
    awareness,
    setLocalState(state) {
      awareness.setLocalState(state);
    },
    setLocalStateField(field, value) {
      awareness.setLocalStateField(field, value);
    },
    localBroadcast,
    applyPeers(peers) {
      const present = new Set<number>();
      for (const peer of peers) {
        const payload = peer.data as Partial<AwarenessBroadcast> | undefined;
        if (!payload || typeof payload.aw !== "string" || typeof payload.ac !== "number") continue;
        if (payload.ac === awareness.clientID) continue; // ignore our own state echoed back
        present.add(payload.ac);
        knownRemote.add(payload.ac);
        try {
          applyAwarenessUpdate(awareness, base64ToBytes(payload.aw), REMOTE_AWARENESS);
        } catch {
          // A corrupt/foreign awareness payload must not brick presence — skip it.
        }
      }
      const gone = [...knownRemote].filter((client) => !present.has(client));
      if (gone.length > 0) {
        for (const client of gone) knownRemote.delete(client);
        removeAwarenessStates(awareness, gone, REMOTE_AWARENESS);
      }
    },
    destroy() {
      awareness.off("update", onUpdate);
      removeAwarenessStates(awareness, [awareness.clientID], REMOTE_AWARENESS);
      awareness.destroy();
    }
  };
}

export interface UseDocAwarenessOptions {
  /** Document identity — presence is broadcast tagged with this and peers are filtered to
   *  it, so many docs can share one workspace/project presence scope. */
  readonly docId: string;
  /** Presence sync scope (a workspace or project you are a member of). Defaults to your
   *  own user scope — see `usePresence`. */
  readonly scope?: { readonly workspace?: string; readonly project?: string };
  /** Local awareness state (e.g. `{ user: { name, color } }`). */
  readonly state?: Record<string, unknown> | null;
  /** Presence heartbeat interval. Cursors want this LOW — presence broadcasts on the beat,
   *  so this bounds cursor latency. Default 250 ms. */
  readonly heartbeatMs?: number;
}

export interface UseDocAwarenessResult {
  /** The shared y-protocols Awareness — pass to y-prosemirror's `yCursorPlugin`. */
  readonly awareness: Awareness;
}

/**
 * React binding: a shared `Awareness` for `doc`, broadcast over `usePresence`. Set your
 * cursor/selection on the returned awareness (y-prosemirror does this for you); peers'
 * cursors arrive on each presence beat.
 *
 * ```tsx
 * const { doc } = useCollaborativeDoc({ docId, updates, append });
 * const { awareness } = useDocAwareness(doc, { docId, scope: { workspace }, state: { user } });
 * // editorProps: ySyncPlugin(doc.getXmlFragment("prosemirror")), yCursorPlugin(awareness)
 * ```
 *
 * Latency note: `usePresence` broadcasts on its heartbeat, so cursor updates lag up to
 * `heartbeatMs`. See the report's core-API gap on a push-granularity presence channel.
 */
export function useDocAwareness(doc: Y.Doc, options: UseDocAwarenessOptions): UseDocAwarenessResult {
  const { docId, scope, state, heartbeatMs = 250 } = options;

  // One DocAwareness per Y.Doc. `onBroadcast` pushes the latest payload into React state,
  // which `usePresence` then heartbeats out.
  const [payload, setPayload] = useState<AwarenessBroadcast | null>(null);
  const docAwareness = useMemo(
    () => createDocAwareness(doc, { state: state ?? null, onBroadcast: setPayload }),
    // state is read once at creation; changes flow through setLocalState below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc]
  );
  useEffect(() => () => docAwareness.destroy(), [docAwareness]);
  useEffect(() => {
    if (payload === null) setPayload(docAwareness.localBroadcast());
  }, [docAwareness, payload]);

  // Reflect a changing `state` prop into the local awareness (re-broadcast happens via
  // the update handler).
  useEffect(() => {
    if (state !== undefined) docAwareness.setLocalState(state);
  }, [docAwareness, state]);

  // Broadcast our payload + docId, and receive peers, over the presence transport.
  const data = useMemo(() => ({ doc: docId, ...(payload ?? {}) }), [docId, payload]);
  const { others } = usePresence(scope, data, { heartbeatMs });

  useEffect(() => {
    docAwareness.applyPeers(
      others
        .filter((peer) => (peer.data as { doc?: unknown }).doc === docId)
        .map((peer) => ({ clientId: peer.clientId, data: peer.data }))
    );
  }, [docAwareness, others, docId]);

  return { awareness: docAwareness.awareness };
}
