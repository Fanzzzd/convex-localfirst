/**
 * Multi-tab sync leadership. Only the leader tab runs background push/pull so a
 * mutation is not pushed N times from N open tabs. Uses the Web Locks API — the robust
 * browser primitive whose lock auto-releases when a tab crashes or closes, so failover
 * needs no heartbeat or hand-rolled election.
 *
 * The React provider only engages multi-tab when Web Locks is present, and every browser
 * that ships IndexedDB (which this library requires for persistence) also ships Web Locks.
 * Without Web Locks a tab simply leads itself and syncs; concurrent tabs would then each
 * push, but the server ledger dedupes by opId, so the result is correct (just less
 * efficient). That keeps this the single, crash-safe coordination path — no second
 * election protocol to keep correct.
 */
export type LeadershipOptions = {
  /** Lock name; tabs sharing it elect a single leader (whoever holds the exclusive lock). */
  readonly name: string;
  /** Stable id for this tab (the engine's clientId). */
  readonly id: string;
  readonly onChange?: (isLeader: boolean) => void;
  /**
   * Injectable Web Locks manager. `undefined` → use navigator.locks if present;
   * `null` → no Web Locks, so this tab leads itself (used by tests / non-browser).
   */
  readonly locks?: LockManagerLike | null;
};

/** The slice of the Web Locks API we use (navigator.locks). */
export type LockManagerLike = {
  request(
    name: string,
    options: { mode?: "exclusive" | "shared"; signal?: AbortSignal },
    callback: () => Promise<unknown>
  ): Promise<unknown>;
};

export class TabLeadership {
  private leader = false;
  private stopped = false;
  private abort: AbortController | null = null;
  private releaseLock: (() => void) | null = null;

  constructor(private readonly options: LeadershipOptions) {}

  isLeader(): boolean {
    return this.leader;
  }

  /** Begin acquisition. Resolves once the request is issued (Web Locks) or immediately
   *  (no Web Locks → this tab self-leads). Leadership changes thereafter via onChange. */
  start(): Promise<void> {
    const locks = this.resolveLocks();
    if (locks) {
      return this.startWithLocks(locks);
    }
    // No Web Locks: this class can't coordinate across tabs (the React provider only engages
    // multi-tab when Web Locks is present). A direct caller without locks gets sole-tab
    // behavior — lead immediately so its engine runs sync rather than staying gated.
    this.setLeader(true);
    return Promise.resolve();
  }

  stop(): void {
    this.stopped = true;
    // Releasing the held promise frees the lock so a waiting tab leads; aborting cancels a
    // pending (follower) request. The browser also auto-releases if this tab crashes.
    this.releaseLock?.();
    this.releaseLock = null;
    this.abort?.abort();
    this.setLeader(false);
  }

  private resolveLocks(): LockManagerLike | null {
    if (this.options.locks !== undefined) {
      return this.options.locks;
    }
    const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
    return nav?.locks ?? null;
  }

  private startWithLocks(locks: LockManagerLike): Promise<void> {
    this.abort = new AbortController();
    // Holding an exclusive lock named `name` == being the leader. The callback runs only
    // once the lock is granted; until then this tab is a follower. The browser frees the
    // lock if this tab dies, so a dead leader fails over automatically.
    void locks
      .request(this.options.name, { mode: "exclusive", signal: this.abort.signal }, () => {
        if (this.stopped) {
          return Promise.resolve();
        }
        this.setLeader(true);
        return new Promise<void>((release) => {
          this.releaseLock = release;
        });
      })
      .catch(() => {
        // AbortError (stopped before acquiring) or a lock failure: stay a follower.
      });
    // "Settled" = request issued; leadership arrives via onChange when the lock is held.
    return Promise.resolve();
  }

  private setLeader(value: boolean): void {
    if (this.leader !== value) {
      this.leader = value;
      this.options.onChange?.(value);
    }
  }
}
