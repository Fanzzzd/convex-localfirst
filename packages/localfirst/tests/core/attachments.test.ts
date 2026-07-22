import { describe, expect, it } from "vitest";
import {
  MemoryLocalStore,
  byUser,
  defineLocalFirstManifest,
  localMutation,
  localTable,
  type AttachmentBackend,
  type LocalFirstManifest,
  type PushResponse,
  type SyncTransport,
  type XhrLike,
} from "../../src/core/index.js";
import { LocalFirstEngine } from "../../src/core/internal.js";

// ---- fixtures ---------------------------------------------------------------

function attachmentsManifest(): LocalFirstManifest {
  return defineLocalFirstManifest({
    schemaVersion: 1,
    tables: {
      attachments: localTable({
        table: "attachments",
        idField: "localId",
        scope: byUser("ownerId"),
        indexes: {},
      }),
    },
    queries: {},
    mutations: {
      "attachments:create": localMutation<{ localId?: string; name: string; issueId: string }>({
        kind: "mutation",
        name: "attachments:create",
        table: "attachments",
        plan: (args, ctx) => ({
          kind: "insert",
          table: "attachments",
          id: args.localId ?? ctx.localId("attachments"),
          value: {
            ownerId: ctx.userId ?? "anon",
            name: args.name,
            issueId: args.issueId,
            storageId: null,
          },
        }),
      }),
      "attachments:remove": localMutation<{ id: string }>({
        kind: "mutation",
        name: "attachments:remove",
        table: "attachments",
        plan: (args) => ({ kind: "delete", table: "attachments", id: args.id }),
      }),
    },
  });
}

/** Push transport that accepts everything (metadata inserts ack immediately). */
function acceptAll(): SyncTransport {
  return {
    async push(request): Promise<PushResponse> {
      return {
        accepted: request.mutations.map((op) => ({ opId: op.opId, serverResult: { ok: true } })),
        rejected: [],
        idMaps: [],
        changes: [],
        serverTime: 1,
      };
    },
    async pull() {
      return { changes: [], cursors: {}, serverTime: 1 };
    },
  };
}

/** Offline: push never settles (metadata op stays owed → uploader is gated). */
function offline(): SyncTransport {
  return { push: () => new Promise<PushResponse>(() => {}), pull: () => new Promise(() => {}) };
}

/** Controllable fake upload endpoint + XHR (the Convex POST → { storageId }). */
class FakeEndpoint {
  mode: "auto" | "manual" = "auto";
  /** Per-attempt outcomes; defaults to "ok" when the queue drains. */
  outcomes: Array<"ok" | "neterror" | "http500"> = [];
  progress: Array<[number, number]> = [];
  seq = 0;
  readonly live: FakeXhr[] = [];
  createXhr = (): XhrLike => new FakeXhr(this) as unknown as XhrLike;
  nextOutcome(): "ok" | "neterror" | "http500" {
    return this.outcomes.shift() ?? "ok";
  }
}

class FakeXhr {
  status = 0;
  responseText = "";
  upload: {
    onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;
  constructor(private readonly endpoint: FakeEndpoint) {}
  open(): void {}
  setRequestHeader(): void {}
  send(): void {
    this.endpoint.live.push(this);
    if (this.endpoint.mode === "auto") queueMicrotask(() => this.drive());
  }
  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
  emitProgress(loaded: number, total: number): void {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  succeed(storageId?: string): void {
    this.status = 200;
    this.responseText = JSON.stringify({
      storageId: storageId ?? `storage_${++this.endpoint.seq}`,
    });
    this.onload?.();
  }
  drive(): void {
    if (this.aborted) return;
    for (const [loaded, total] of this.endpoint.progress) this.emitProgress(loaded, total);
    const outcome = this.endpoint.nextOutcome();
    if (this.aborted) return;
    if (outcome === "ok") this.succeed();
    else if (outcome === "http500") {
      this.status = 500;
      this.onload?.();
    } else this.onerror?.();
  }
}

type BackendControl = {
  backend: AttachmentBackend;
  calls: {
    getUploadUrl: Array<{ table: string; localId: string }>;
    finalize: Array<{ table: string; localId: string; storageId: string }>;
  };
  finalizeError: Error | null;
  finalizeGate: Promise<void> | null;
};

function makeBackend(): BackendControl {
  const control: BackendControl = {
    calls: { getUploadUrl: [], finalize: [] },
    finalizeError: null,
    finalizeGate: null,
    backend: null as unknown as AttachmentBackend,
  };
  control.backend = {
    async getUploadUrl(input) {
      control.calls.getUploadUrl.push(input);
      return `https://upload.test/${input.localId}`;
    },
    async finalize(input) {
      control.calls.finalize.push(input);
      if (control.finalizeGate) await control.finalizeGate;
      if (control.finalizeError) throw control.finalizeError;
    },
  };
  return control;
}

let idSeq = 0;
function makeEngine(opts: {
  store: MemoryLocalStore;
  transport: SyncTransport;
  backend: AttachmentBackend;
  createXhr?: () => XhrLike;
  clientId?: string;
}): LocalFirstEngine {
  let now = 1000;
  return new LocalFirstEngine({
    manifest: attachmentsManifest(),
    store: opts.store,
    clientId: opts.clientId ?? "c1",
    userId: "user_a",
    transport: opts.transport,
    nameOf: (reference) => String(reference),
    idFactory: () => `att_${++idSeq}`,
    clock: () => now++,
    retry: { retries: 3, baseDelayMs: 1 },
    sleep: () => Promise.resolve(),
    syncTimeoutMs: 0,
    attachments: { backend: opts.backend, createXhr: opts.createXhr, storageIdField: "storageId" },
  });
}

async function until(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const blobOf = (text: string) => new Blob([text], { type: "text/plain" });

// ---- tests ------------------------------------------------------------------

describe("attachments — happy path", () => {
  it("uploads, finalizes, and evicts the blob only after finalize confirmed", async () => {
    const store = new MemoryLocalStore();
    const endpoint = new FakeEndpoint();
    const bc = makeBackend();
    // Finalize gated so we can observe the blob is still present until it resolves.
    let releaseFinalize: () => void = () => {};
    bc.finalizeGate = new Promise<void>((resolve) => (releaseFinalize = resolve));
    const engine = makeEngine({
      store,
      transport: acceptAll(),
      backend: bc.backend,
      createXhr: endpoint.createXhr,
    });

    const { localId } = await engine.createAttachment({
      insert: "attachments:create",
      metadata: { name: "f.txt", issueId: "i1" },
      blob: blobOf("hello"),
    });

    // Metadata row is optimistic immediately (synced/rebased like any row).
    const row = await engine.getRow<{ name: string }>("attachments", localId);
    expect(row?.name).toBe("f.txt");

    // Upload proceeds; finalize is called but gated — the blob must NOT be evicted yet.
    await until(() => bc.calls.finalize.length === 1, "finalize called");
    expect(await store.getBlob(localId)).not.toBeNull();
    expect(engine.getAttachmentState(localId)?.state).toBe("uploading");

    releaseFinalize();
    await until(async () => (await store.getBlob(localId)) === null, "blob evicted after finalize");
    expect(engine.getAttachmentState(localId)?.state).toBe("done");
    expect(bc.calls.finalize[0]).toMatchObject({ table: "attachments", localId });
    engine.dispose();
  });
});

describe("attachments — offline create then resume on reload", () => {
  it("creates fully offline, then a reloaded online leader resumes the upload", async () => {
    const store = new MemoryLocalStore();
    const endpoint = new FakeEndpoint();
    const bc1 = makeBackend();
    // First session is offline: metadata never syncs, so the uploader is gated.
    const engine1 = makeEngine({
      store,
      transport: offline(),
      backend: bc1.backend,
      createXhr: endpoint.createXhr,
    });
    engine1.setOnline(false);
    const { localId } = await engine1.createAttachment({
      insert: "attachments:create",
      metadata: { name: "offline.txt", issueId: "i9" },
      blob: blobOf("bytes"),
    });
    // Blob is durable; nothing uploaded while offline.
    expect(await store.getBlob(localId)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    expect(bc1.calls.getUploadUrl).toHaveLength(0);
    engine1.dispose();

    // "Reload": a fresh engine over the SAME durable store, now online.
    const endpoint2 = new FakeEndpoint();
    const bc2 = makeBackend();
    const engine2 = makeEngine({
      store,
      transport: acceptAll(),
      backend: bc2.backend,
      createXhr: endpoint2.createXhr,
      clientId: "c2",
    });
    // Push the inherited pending metadata op, unblocking the upload gate.
    await engine2.syncOnce();
    await until(async () => (await store.getBlob(localId)) === null, "resumed upload evicts blob");
    expect(bc2.calls.finalize).toHaveLength(1);
    engine2.dispose();
  });
});

describe("attachments — quota failure on blob persist", () => {
  it("leaves NO orphan metadata row when the blob cannot be persisted", async () => {
    const store = new MemoryLocalStore();
    const endpoint = new FakeEndpoint();
    const bc = makeBackend();
    store.putBlob = () => Promise.reject(new Error("QuotaExceededError"));
    const engine = makeEngine({
      store,
      transport: acceptAll(),
      backend: bc.backend,
      createXhr: endpoint.createXhr,
    });

    await expect(
      engine.createAttachment({
        insert: "attachments:create",
        metadata: { name: "big", issueId: "i1" },
        blob: blobOf("x"),
      }),
    ).rejects.toThrow(/Quota/);

    // No metadata row, no pending op — the insert never happened (blob-first ordering).
    expect(await store.getCanonicalRows("attachments")).toHaveLength(0);
    expect(await store.getAllOperations()).toHaveLength(0);
    engine.dispose();
  });
});

describe("attachments — upload retry/backoff", () => {
  it("retries transient network failures then succeeds", async () => {
    const store = new MemoryLocalStore();
    const endpoint = new FakeEndpoint();
    endpoint.outcomes = ["neterror", "neterror", "ok"]; // fail twice, then succeed
    const bc = makeBackend();
    const engine = makeEngine({
      store,
      transport: acceptAll(),
      backend: bc.backend,
      createXhr: endpoint.createXhr,
    });

    const { localId } = await engine.createAttachment({
      insert: "attachments:create",
      metadata: { name: "retry.txt", issueId: "i1" },
      blob: blobOf("data"),
    });
    await until(async () => (await store.getBlob(localId)) === null, "eventual success");
    expect(bc.calls.getUploadUrl.length).toBe(3); // one url per attempt
    expect(bc.calls.finalize).toHaveLength(1);
    expect(engine.getAttachmentState(localId)?.state).toBe("done");
    engine.dispose();
  });
});

describe("attachments — finalize rejection", () => {
  it("surfaces recovery and RETAINS the blob after retry exhaustion", async () => {
    const store = new MemoryLocalStore();
    const endpoint = new FakeEndpoint();
    const bc = makeBackend();
    bc.finalizeError = new Error("finalize denied");
    const engine = makeEngine({
      store,
      transport: acceptAll(),
      backend: bc.backend,
      createXhr: endpoint.createXhr,
    });

    const { localId } = await engine.createAttachment({
      insert: "attachments:create",
      metadata: { name: "denied.txt", issueId: "i1" },
      blob: blobOf("data"),
    });
    await until(() => engine.getAttachmentState(localId)?.state === "failed", "failed state");
    // Blob retained (never evicted before a confirmed finalize).
    expect(await store.getBlob(localId)).not.toBeNull();
    const recovery = engine.getRecoveryStatus();
    expect(recovery.failedAttachments).toHaveLength(1);
    expect(recovery.failedAttachments[0]).toMatchObject({ localId, table: "attachments" });
    expect(engine.getAttachmentState(localId)?.error).toContain("finalize denied");
    engine.dispose();
  });
});

describe("attachments — leader death mid-upload", () => {
  it("resumes on a promoted follower over the shared durable store", async () => {
    const store = new MemoryLocalStore();
    // Leader whose finalize hangs forever (dies mid-upload without evicting).
    const endpoint1 = new FakeEndpoint();
    const bc1 = makeBackend();
    bc1.finalizeGate = new Promise<void>(() => {});
    const leader = makeEngine({
      store,
      transport: acceptAll(),
      backend: bc1.backend,
      createXhr: endpoint1.createXhr,
      clientId: "leader",
    });

    const { localId } = await leader.createAttachment({
      insert: "attachments:create",
      metadata: { name: "resume.txt", issueId: "i1" },
      blob: blobOf("payload"),
    });
    await until(() => bc1.calls.finalize.length === 1, "leader started finalize");
    expect(await store.getBlob(localId)).not.toBeNull(); // not evicted — leader is stuck

    // Leader dies.
    leader.dispose();

    // A follower is promoted (it starts gated, then gains leadership).
    const endpoint2 = new FakeEndpoint();
    const bc2 = makeBackend();
    const follower = makeEngine({
      store,
      transport: acceptAll(),
      backend: bc2.backend,
      createXhr: endpoint2.createXhr,
      clientId: "follower",
    });
    follower.setSyncEnabled(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(bc2.calls.getUploadUrl).toHaveLength(0); // follower does not upload
    follower.setSyncEnabled(true); // promoted

    await until(async () => (await store.getBlob(localId)) === null, "follower resumes and evicts");
    expect(bc2.calls.finalize).toHaveLength(1);
    follower.dispose();
  });
});

describe("attachments — delete before upload", () => {
  it("cancels the upload and drops the blob when the row is deleted first", async () => {
    const store = new MemoryLocalStore();
    const endpoint = new FakeEndpoint();
    const bc = makeBackend();
    // Offline: metadata never syncs, so the upload stays gated and cancellable.
    const engine = makeEngine({
      store,
      transport: offline(),
      backend: bc.backend,
      createXhr: endpoint.createXhr,
    });

    const { localId } = await engine.createAttachment({
      insert: "attachments:create",
      metadata: { name: "temp.txt", issueId: "i1" },
      blob: blobOf("data"),
    });
    expect(await store.getBlob(localId)).not.toBeNull();

    await engine.mutate("attachments:remove", { id: localId }).local;
    await until(async () => (await store.getBlob(localId)) === null, "blob dropped on delete");
    expect(bc.calls.finalize).toHaveLength(0);
    expect(bc.calls.getUploadUrl).toHaveLength(0);
    engine.dispose();
  });
});

describe("attachments — progress", () => {
  it("surfaces byte progress to the upload state", async () => {
    const store = new MemoryLocalStore();
    const endpoint = new FakeEndpoint();
    endpoint.mode = "manual"; // we drive the XHR by hand to observe intermediate progress
    const bc = makeBackend();
    const engine = makeEngine({
      store,
      transport: acceptAll(),
      backend: bc.backend,
      createXhr: endpoint.createXhr,
    });

    const { localId } = await engine.createAttachment({
      insert: "attachments:create",
      metadata: { name: "prog.txt", issueId: "i1" },
      blob: blobOf("data"),
    });
    await until(() => endpoint.live.length === 1, "xhr started");
    const xhr = endpoint.live[0]!;
    xhr.emitProgress(50, 100);
    expect(engine.getAttachmentState(localId)).toMatchObject({ state: "uploading", progress: 0.5 });
    xhr.emitProgress(100, 100);
    expect(engine.getAttachmentState(localId)?.progress).toBe(1);

    xhr.succeed("storage_final");
    await until(async () => (await store.getBlob(localId)) === null, "done after succeed");
    expect(bc.calls.finalize[0]).toMatchObject({ localId, storageId: "storage_final" });
    engine.dispose();
  });
});
