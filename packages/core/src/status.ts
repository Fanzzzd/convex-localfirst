import type { SyncStatus } from "./types.js";

export const initialSyncStatus: SyncStatus = {
  online: true,
  syncing: false,
  pendingMutations: 0,
  lastPushAt: null,
  lastPullAt: null,
  lastError: null,
  blockedBySchemaMismatch: false,
  partial: false
};
