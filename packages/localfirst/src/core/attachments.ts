import type { LocalStore, StoredBlob } from "./storage.js";
import type {
  AttachmentRecovery,
  AttachmentUploadState,
  LocalCommit,
  LocalId,
  LocalOperation,
  RowDelta,
  TableName,
} from "./types.js";

/**
 * Backend the uploader drives — injected so core stays backend-agnostic. The React
 * adapter wires these to app-provided Convex mutations (getUploadUrl / finalize).
 *
 * Upload flow per attachment: getUploadUrl → POST the blob (progress) → finalize.
 * The default POST uses XMLHttpRequest so byte-level progress events are available;
 * apps that need a different upload path can provide `upload`.
 */
export type AttachmentBackend = {
  /** App mutation: authorize the caller (must be allowed to write the table) and
   *  return a one-shot upload URL (Convex `ctx.storage.generateUploadUrl()`). */
  getUploadUrl(input: { table: TableName; localId: LocalId }): Promise<string>;
  /** App mutation: patch the metadata row's storageId server-side (via serverWriter),
   *  so every client syncs it. Resolves only when the server confirms. */
  finalize(input: { table: TableName; localId: LocalId; storageId: string }): Promise<void>;
  /** Override the default XHR POST. Must resolve `{ storageId }` (Convex upload
   *  convention: the POST response body is `{ storageId }`). */
  upload?(input: {
    url: string;
    blob: Blob;
    onProgress: (fraction: number) => void;
  }): Promise<{ storageId: string }>;
};

/** The slice of XMLHttpRequest the default uploader uses (injectable for tests). */
export type XhrLike = {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: unknown): void;
  abort(): void;
  status: number;
  responseText: string;
  upload: {
    onprogress:
      | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void)
      | null;
  };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
};

export type AttachmentManagerOptions = {
  readonly backend?: AttachmentBackend;
  /** Field on the metadata row the server stamps with the storage id. Its presence
   *  means "uploaded"; a synced-in value (e.g. a follower tab's leader finalized)
   *  triggers local blob eviction. Default "storageId". */
  readonly storageIdField?: string;
  readonly retry: { readonly retries: number; readonly baseDelayMs: number };
  readonly sleep: (ms: number) => Promise<void>;
  /** XHR factory for the default uploader (tests inject a fake). Defaults to
   *  `new XMLHttpRequest()` when available. */
  readonly createXhr?: () => XhrLike;
  readonly clock?: () => number;
};

/** The engine surface the manager drives — kept small so it is unit-testable with a
 *  fake host (no real engine needed). */
export type AttachmentHost = {
  /** navigator.onLine AND the engine's soft online status. */
  isOnline(): boolean;
  /** Multi-tab single-writer gate: only the leader uploads. */
  isLeader(): boolean;
  newLocalId(table: TableName): string;
  /** The table an insert mutation reference targets (from the manifest), or null. */
  resolveInsertTable(reference: unknown): TableName | null;
  /** Insert the metadata row through the NORMAL local-first path, forcing the row's
   *  id to `localId` (so it matches the blob key). Resolves the durable local commit. */
  mutateInsert(
    reference: unknown,
    args: Record<string, unknown>,
    localId: LocalId,
  ): Promise<LocalCommit>;
  getOperation(opId: string): Promise<LocalOperation | null>;
  /** Publish the current failed-attachment set into the recovery status channel. */
  onRecoveryChange(list: readonly AttachmentRecovery[]): void;
};

/** Thrown internally to stop a retry loop when the attachment was cancelled (its
 *  metadata row was deleted before the upload finished). */
class AttachmentCancelled extends Error {}

const DEFAULT_STATE: AttachmentUploadState = { state: "queued", progress: null };

/**
 * Leader-owned background uploader for offline-created attachments (P5).
 *
 * `create` persists the blob durably AND inserts the metadata row optimistically
 * (blob FIRST so a quota failure leaves no orphan row). The queue then uploads —
 * only when online + leader — with retry/backoff, and is resumable across reloads
 * (boot re-scans the durable blob store). A blob is evicted ONLY after the server
 * confirms finalize; failures after retry exhaustion surface through the recovery
 * status channel and RETAIN the blob for a later retry.
 */
export class AttachmentManager {
  private readonly store: LocalStore;
  private readonly host: AttachmentHost;
  private readonly backend?: AttachmentBackend;
  private readonly storageIdField: string;
  private readonly retry: { readonly retries: number; readonly baseDelayMs: number };
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly createXhr?: () => XhrLike;
  private readonly clock: () => number;

  // localIds we hold a durable blob for (or are finishing). Populated on boot from
  // the shared store and on every create — the delta-bus filter reads it so it never
  // hits the store per unrelated row change.
  private readonly tracked = new Set<LocalId>();
  private readonly queue: LocalId[] = [];
  private readonly states = new Map<LocalId, AttachmentUploadState>();
  private readonly active = new Map<LocalId, { cancelled: boolean; xhr?: XhrLike }>();
  private readonly failed = new Map<LocalId, AttachmentRecovery>();
  private readonly perIdListeners = new Map<LocalId, Set<() => void>>();
  private processing = false;
  // Set when a trigger (wake/create/outcome) fires mid-pass, so the loop takes one
  // more pass and never strands an item that became ready during processing.
  private rerun = false;
  private hydrated = false;

  constructor(store: LocalStore, host: AttachmentHost, options: AttachmentManagerOptions) {
    this.store = store;
    this.host = host;
    this.backend = options.backend;
    this.storageIdField = options.storageIdField ?? "storageId";
    this.retry = options.retry;
    this.sleep = options.sleep;
    this.createXhr = options.createXhr;
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Re-enter every durable blob into the queue (boot, and whenever leadership/online
   *  is (re)gained so an inherited backlog resumes — e.g. after a leader tab died). */
  async hydrate(): Promise<void> {
    let blobs: readonly StoredBlob[];
    try {
      blobs = await this.store.getAllBlobs();
    } catch {
      return; // a transient store error must not wedge the engine
    }
    for (const blob of blobs) {
      this.tracked.add(blob.localId);
      const current = this.states.get(blob.localId);
      if (!current || current.state === "failed") this.setState(blob.localId, DEFAULT_STATE);
      // Clear a prior failure record so a resume retries fresh.
      if (this.failed.delete(blob.localId)) this.publishRecovery();
      if (!this.queue.includes(blob.localId)) this.queue.push(blob.localId);
    }
    this.hydrated = true;
    void this.processQueue();
  }

  /** Leadership changed (multi-tab). Gaining leadership resumes any inherited backlog. */
  setLeader(_isLeader: boolean): void {
    void this.wake();
  }

  /** Connectivity changed. Coming online resumes the queue. */
  setOnline(_online: boolean): void {
    void this.wake();
  }

  /** Re-scan durable blobs then process — the resume path shared by boot, leadership
   *  gain, and reconnect. Idempotent and safe to over-call. */
  async wake(): Promise<void> {
    if (this.hydrated) await this.hydrate();
    else void this.processQueue();
  }

  /**
   * Create an attachment: persist the blob durably, then insert the metadata row
   * optimistically through the normal local-first path (forcing the row id to the
   * blob key). Blob FIRST so a quota failure on persist leaves NO orphan row; a
   * failed metadata insert rolls the blob back. Fully succeeds offline.
   */
  async create(input: {
    insert: unknown;
    metadata: Record<string, unknown>;
    blob: Blob;
  }): Promise<{ localId: LocalId }> {
    if (!this.backend) {
      throw new Error(
        "convex-localfirst: attachments are not configured. Pass `attachments` to the ConvexProvider / createConvexLocalFirst (getUploadUrl + finalize function refs).",
      );
    }
    const table = this.host.resolveInsertTable(input.insert);
    if (!table) {
      throw new Error(
        "convex-localfirst: createAttachment needs a local-first INSERT mutation reference (from an lf.table) whose table is in the manifest.",
      );
    }
    const localId = this.host.newLocalId(table);
    // Blob first: on a quota failure this throws with nothing else written (no row,
    // no tracking) — the caller sees the failure and there is no orphan.
    await this.store.putBlob({ localId, table, blob: input.blob, createdAt: this.clock() });
    this.tracked.add(localId);
    this.setState(localId, DEFAULT_STATE);
    let commit: LocalCommit;
    try {
      commit = await this.host.mutateInsert(input.insert, input.metadata, localId);
    } catch (error) {
      // Roll back the orphan blob (its metadata row never committed).
      await this.store.deleteBlob(localId).catch(() => {});
      this.tracked.delete(localId);
      this.states.delete(localId);
      throw error;
    }
    // Record the metadata op so the uploader can gate on it being synced. Best-effort:
    // a failure here only downgrades to attempt+retry, never loses the blob.
    await this.store
      .putBlob({ localId, table, blob: input.blob, opId: commit.opId, createdAt: this.clock() })
      .catch(() => {});
    if (!this.queue.includes(localId)) this.queue.push(localId);
    void this.processQueue();
    return { localId };
  }

  /** Handle row deltas for tracked attachments: a delete cancels the upload and drops
   *  the blob (delete-before-upload); a storageId appearing (finalize synced from
   *  another tab/leader) evicts the local blob. */
  handleDeltas(deltas: readonly RowDelta[]): void {
    for (const delta of deltas) {
      if (!this.tracked.has(delta.localId)) continue;
      if (delta.kind === "delete") {
        this.cancel(delta.localId);
        continue;
      }
      const storageId = (delta.row as Record<string, unknown> | null)?.[this.storageIdField];
      if (storageId != null && !this.active.has(delta.localId)) {
        // Confirmed elsewhere: evict our now-redundant local blob.
        void this.store.deleteBlob(delta.localId).catch(() => {});
        this.removeFromQueue(delta.localId);
        if (this.failed.delete(delta.localId)) this.publishRecovery();
        this.setState(delta.localId, { state: "done", progress: 1 });
      }
    }
  }

  /** Cancel an in-flight/queued upload and drop its blob (metadata row deleted before
   *  upload). Aborts any active XHR so bytes stop immediately. */
  cancel(localId: LocalId): void {
    const active = this.active.get(localId);
    if (active) {
      active.cancelled = true;
      try {
        active.xhr?.abort();
      } catch {
        // ignore
      }
    }
    this.removeFromQueue(localId);
    this.tracked.delete(localId);
    this.states.delete(localId);
    if (this.failed.delete(localId)) this.publishRecovery();
    void this.store.deleteBlob(localId).catch(() => {});
    this.notify(localId);
  }

  getState(localId: LocalId): AttachmentUploadState | null {
    return this.states.get(localId) ?? null;
  }

  subscribe(localId: LocalId, listener: () => void): () => void {
    let set = this.perIdListeners.get(localId);
    if (!set) {
      set = new Set();
      this.perIdListeners.set(localId, set);
    }
    set.add(listener);
    return () => {
      const current = this.perIdListeners.get(localId);
      current?.delete(listener);
      if (current && current.size === 0) this.perIdListeners.delete(localId);
    };
  }

  // ---- internals ----------------------------------------------------------

  private async processQueue(): Promise<void> {
    if (!this.backend || !this.host.isLeader() || !this.host.isOnline()) return;
    if (this.processing) {
      // A trigger fired mid-pass; ask the running loop to take one more pass.
      this.rerun = true;
      return;
    }
    this.processing = true;
    try {
      do {
        this.rerun = false;
        // Snapshot: uploadOne mutates the queue, and a delta/cancel may too.
        // oxlint-disable-next-line no-useless-spread -- the copy is the snapshot the comment describes
        for (const localId of [...this.queue]) {
          if (!this.host.isLeader() || !this.host.isOnline()) return;
          if (!this.queue.includes(localId)) continue; // cancelled mid-pass
          const record = await this.store.getBlob(localId);
          if (!record) {
            this.removeFromQueue(localId);
            continue;
          }
          // Gate on the metadata row being synced server-side (so getUploadUrl can
          // authorize against it and finalize can patch it). If still owed, skip —
          // a later ack (via wake/outcome) re-triggers processing.
          if (record.opId) {
            const op = await this.host.getOperation(record.opId);
            if (op && (op.status === "pending" || op.status === "pushing")) continue;
            if (op && op.status === "rejected") {
              this.markFailed(
                localId,
                record.table,
                `Attachment metadata was rejected: ${op.error ?? "rejected"}`,
              );
              this.removeFromQueue(localId);
              this.tracked.delete(localId);
              await this.store.deleteBlob(localId).catch(() => {});
              continue;
            }
          }
          await this.uploadOne(localId, record);
          this.removeFromQueue(localId); // done → evicted; failed → blob retained, out of active queue
        }
      } while (this.rerun && this.host.isLeader() && this.host.isOnline());
    } finally {
      this.processing = false;
    }
  }

  private async uploadOne(localId: LocalId, record: StoredBlob): Promise<void> {
    const backend = this.backend!;
    const control = { cancelled: false } as { cancelled: boolean; xhr?: XhrLike };
    this.active.set(localId, control);
    this.setState(localId, { state: "uploading", progress: 0 });
    try {
      const storageId = await this.withRetry(async () => {
        if (control.cancelled) throw new AttachmentCancelled();
        const url = await backend.getUploadUrl({ table: record.table, localId });
        const result = await this.doUpload(url, record.blob, localId, control);
        if (control.cancelled) throw new AttachmentCancelled();
        await backend.finalize({ table: record.table, localId, storageId: result.storageId });
        return result.storageId;
      });
      if (control.cancelled) return;
      // NEVER evict before a confirmed finalize — reached only after finalize resolved.
      await this.store.deleteBlob(localId);
      if (this.failed.delete(localId)) this.publishRecovery();
      this.setState(localId, { state: "done", progress: 1 });
      void storageId;
    } catch (error) {
      if (error instanceof AttachmentCancelled || control.cancelled) return;
      const message = error instanceof Error ? error.message : String(error);
      this.markFailed(localId, record.table, message);
    } finally {
      this.active.delete(localId);
    }
  }

  /** POST the blob and resolve `{ storageId }`. Default is an XHR POST with progress;
   *  overridden by backend.upload when provided. */
  private async doUpload(
    url: string,
    blob: Blob,
    localId: LocalId,
    control: { cancelled: boolean; xhr?: XhrLike },
  ): Promise<{ storageId: string }> {
    const backend = this.backend!;
    if (backend.upload) {
      return backend.upload({
        url,
        blob,
        onProgress: (fraction) => {
          if (!control.cancelled)
            this.setState(localId, { state: "uploading", progress: fraction });
        },
      });
    }
    const factory =
      this.createXhr ??
      (typeof XMLHttpRequest !== "undefined"
        ? () => new XMLHttpRequest() as unknown as XhrLike
        : undefined);
    if (!factory) {
      throw new Error(
        "convex-localfirst: no XMLHttpRequest available for attachment upload; provide attachments.createXhr or backend.upload.",
      );
    }
    return new Promise<{ storageId: string }>((resolve, reject) => {
      const xhr = factory();
      control.xhr = xhr;
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0 && !control.cancelled) {
          this.setState(localId, { state: "uploading", progress: event.loaded / event.total });
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const body = JSON.parse(xhr.responseText) as { storageId?: string };
            if (typeof body.storageId === "string") resolve({ storageId: body.storageId });
            else reject(new Error("Attachment upload response did not include a storageId."));
          } catch {
            reject(new Error("Attachment upload response was not valid JSON."));
          }
        } else {
          reject(new Error(`Attachment upload failed: HTTP ${xhr.status}.`));
        }
      };
      xhr.onerror = () => reject(new Error("Attachment upload failed: network error."));
      xhr.onabort = () => reject(new AttachmentCancelled());
      xhr.open("POST", url);
      if (blob.type) xhr.setRequestHeader("Content-Type", blob.type);
      xhr.send(blob);
    });
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retry.retries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof AttachmentCancelled) throw error;
        lastError = error;
        if (attempt === this.retry.retries) break;
        await this.sleep(this.retry.baseDelayMs * 2 ** attempt);
      }
    }
    throw lastError;
  }

  private markFailed(localId: LocalId, table: TableName, error: string): void {
    this.failed.set(localId, { localId, table, error, createdAt: this.clock() });
    this.publishRecovery();
    this.setState(localId, { state: "failed", progress: null, error });
  }

  private removeFromQueue(localId: LocalId): void {
    const index = this.queue.indexOf(localId);
    if (index !== -1) this.queue.splice(index, 1);
  }

  private setState(localId: LocalId, state: AttachmentUploadState): void {
    this.states.set(localId, state);
    this.notify(localId);
  }

  private notify(localId: LocalId): void {
    const listeners = this.perIdListeners.get(localId);
    if (listeners) for (const listener of Array.from(listeners)) listener();
  }

  private publishRecovery(): void {
    this.host.onRecoveryChange(Array.from(this.failed.values()));
  }
}
