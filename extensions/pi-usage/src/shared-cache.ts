import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { flockSync as NativeFlockSync } from "fs-ext-extra-prebuilt";
import {
  CACHE_TTL_MS,
  RATE_LIMIT_BACKOFF_MAX_MS,
  REFRESH_LEASE_MS,
  SHARED_CACHE_FILE,
  SHARED_CACHE_VERSION,
} from "./constants.js";
import { reportMatchesModel } from "./models.js";
import { getMutationLockRequireFactory } from "./mutation-lock-backend.js";
import type { ProviderUsageModel, SharedCacheEntry, SharedUsageCache, UsageProviderKey, UsageReport } from "./types.js";

const MUTATION_LOCK_RETRY_MS = 5;
const MUTATION_LOCK_ATTEMPTS = 11;
const mutationLockWaitArray = new Int32Array(new SharedArrayBuffer(4));
type FlockSync = typeof NativeFlockSync;

/** The slice of node:sqlite's DatabaseSync the lock uses. Declared here so the
 * build does not depend on a Node types version that ships node:sqlite. */
type SqliteDatabase = { exec(sql: string): void; close(): void; readonly isTransaction?: boolean };
type SqliteDatabaseConstructor = new (path: string, options: { timeout: number }) => SqliteDatabase;

/** A kernel-held mutation lock. Both backends take a lock the kernel releases
 * when the holder closes it or dies, so there is no stale-owner metadata, PID
 * liveness decision, or takeover path to race. */
type MutationLockBackend =
  | { kind: "flock"; flockSync: FlockSync }
  | { kind: "sqlite"; Database: SqliteDatabaseConstructor };
let mutationLockBackend: MutationLockBackend | undefined;
let mutationLockBackendResolved = false;

/** Resolve a kernel-lock implementation only when a mutation is attempted,
 * in order:
 *   1. the native flock addon (fs-ext-extra-prebuilt), where a prebuilt binary
 *      exists for this Node major;
 *   2. node:sqlite, whose exclusive transaction holds a POSIX fcntl lock. It is
 *      built into Node, so a new Node major (Node 26 has no fs-ext prebuilt)
 *      does not disable the shared cache. It is second because Node 22 prints
 *      an ExperimentalWarning for it.
 * With neither, cache mutation is disabled for this process; reads and the
 * rest of the extension stay usable.
 *
 * flock and fcntl locks do not see each other. Every session on one Node
 * resolves the same backend, so they only differ across a Node major upgrade
 * with sessions still running on the old one. Then two writers can overlap;
 * each replaces the cache by atomic rename, so the cost is a lost update or a
 * duplicate refresh, never a corrupt file.
 */
function resolveMutationLockBackend(): MutationLockBackend | undefined {
  if (mutationLockBackendResolved) return mutationLockBackend;
  mutationLockBackendResolved = true;
  let require: NodeJS.Require;
  try {
    require = getMutationLockRequireFactory()(import.meta.url);
  } catch {
    return undefined;
  }
  try {
    const candidate: unknown = require("fs-ext-extra-prebuilt");
    const flockSync =
      typeof candidate === "object" && candidate !== null ? Reflect.get(candidate, "flockSync") : undefined;
    if (typeof flockSync === "function") {
      mutationLockBackend = { kind: "flock", flockSync: flockSync as FlockSync };
      return mutationLockBackend;
    }
  } catch {
    // No prebuilt binary for this Node major, or a damaged addon: try sqlite.
  }
  try {
    const candidate: unknown = require("node:sqlite");
    const Database =
      typeof candidate === "object" && candidate !== null ? Reflect.get(candidate, "DatabaseSync") : undefined;
    if (typeof Database === "function") {
      mutationLockBackend = { kind: "sqlite", Database: Database as SqliteDatabaseConstructor };
    }
  } catch {
    mutationLockBackend = undefined;
  }
  return mutationLockBackend;
}

export type MutationLockPhase = "after-open" | "after-acquire" | "before-cache-replace" | "after-cache-replace";

type SharedCacheRuntime = {
  cacheFile: string;
  now: () => number;
  rename: typeof renameSync;
  randomUUID: () => string;
  mutationLockPhase?: (phase: MutationLockPhase) => void;
};

const defaultRuntime: SharedCacheRuntime = {
  cacheFile: SHARED_CACHE_FILE,
  now: Date.now,
  rename: renameSync,
  randomUUID,
  mutationLockPhase: undefined,
};
let runtime = defaultRuntime;

/** Isolates cache paths and filesystem failures in tests. Production callers
 * always use the default runtime and the cache under pi's agent directory. */
export function configureSharedCacheForTests(overrides: Partial<SharedCacheRuntime> = {}): void {
  runtime = { ...defaultRuntime, ...overrides };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNormalizedWindow(value: unknown): boolean {
  if (!isRecord(value) || !nonEmptyString(value.id) || !nonEmptyString(value.label)) return false;
  for (const field of ["usedPercent", "resetsAt", "usedAmount", "limitAmount"] as const) {
    if (value[field] !== undefined && !finiteNonNegative(value[field])) return false;
  }
  if (value.windowMinutes !== undefined && (!finiteNonNegative(value.windowMinutes) || value.windowMinutes === 0)) {
    return false;
  }
  if (
    value.state !== undefined &&
    value.state !== "available" &&
    value.state !== "warning" &&
    value.state !== "rejected" &&
    value.state !== "unknown"
  ) {
    return false;
  }
  if (value.currency !== undefined && !nonEmptyString(value.currency)) return false;
  if (!isRecord(value.scope)) return false;
  if (value.scope.kind === "account" || value.scope.kind === "overage") return true;
  if (value.scope.kind === "provider") {
    return nonEmptyString(value.scope.id) && (value.scope.label === undefined || nonEmptyString(value.scope.label));
  }
  return (
    value.scope.kind === "model" &&
    nonEmptyString(value.scope.label) &&
    Array.isArray(value.scope.modelIds) &&
    value.scope.modelIds.length > 0 &&
    value.scope.modelIds.every(nonEmptyString)
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCodexWindow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.usedPercent === "number" &&
    Number.isFinite(value.usedPercent) &&
    (value.windowMinutes === undefined ||
      (typeof value.windowMinutes === "number" && Number.isFinite(value.windowMinutes))) &&
    (value.resetsAt === undefined || (typeof value.resetsAt === "number" && Number.isFinite(value.resetsAt)))
  );
}

function isNormalizedCredits(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.hasCredits === "boolean" &&
    typeof value.unlimited === "boolean" &&
    (value.balance === undefined || typeof value.balance === "string")
  );
}

function isCodexSnapshot(value: unknown): boolean {
  if (!isRecord(value) || typeof value.limitId !== "string") return false;
  if (value.limitName !== undefined && typeof value.limitName !== "string") return false;
  if (value.primary !== undefined && !isCodexWindow(value.primary)) return false;
  if (value.secondary !== undefined && !isCodexWindow(value.secondary)) return false;
  return value.credits === undefined || isNormalizedCredits(value.credits);
}

function isUsageReport(value: unknown, provider: UsageProviderKey): value is UsageReport {
  if (!isRecord(value) || value.provider !== provider) return false;
  if (typeof value.capturedAt !== "number" || !Number.isFinite(value.capturedAt)) return false;

  if (value.source === "external-adapter") {
    return (
      (value.providerLabel === undefined || nonEmptyString(value.providerLabel)) &&
      nonEmptyString(value.snapshotSource) &&
      (value.adapterId === undefined || nonEmptyString(value.adapterId)) &&
      typeof value.complete === "boolean" &&
      Array.isArray(value.modelProviders) &&
      value.modelProviders.length > 0 &&
      value.modelProviders.every(nonEmptyString) &&
      Array.isArray(value.windows) &&
      value.windows.every(isNormalizedWindow)
    );
  }
  if (provider === "claude" && value.source === "anthropic-oauth") {
    return (
      Array.isArray(value.windows) &&
      value.windows.every(isNormalizedWindow) &&
      Array.isArray(value.summaryLines) &&
      value.summaryLines.every((line) => typeof line === "string") &&
      typeof value.statusline === "string"
    );
  }
  return (
    provider === "codex" &&
    (value.source === "pi-auth" || value.source === "codex-app-server") &&
    Array.isArray(value.snapshots) &&
    value.snapshots.every(isCodexSnapshot)
  );
}

function isSharedCacheEntry(value: unknown, provider: UsageProviderKey): value is SharedCacheEntry {
  return (
    isRecord(value) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    isUsageReport(value.report, provider)
  );
}

function isProviderNumberMap(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (["codex", "claude"] as const).every((provider) => {
    const item = value[provider];
    return item === undefined || (typeof item === "number" && Number.isFinite(item));
  });
}

function isRefreshLeaseMap(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (["codex", "claude"] as const).every((provider) => {
    const lease = value[provider];
    return (
      lease === undefined ||
      (isRecord(lease) &&
        typeof lease.owner === "string" &&
        typeof lease.expiresAt === "number" &&
        Number.isFinite(lease.expiresAt))
    );
  });
}

function isSharedUsageCache(value: unknown): value is SharedUsageCache {
  if (!isRecord(value) || value.version !== SHARED_CACHE_VERSION || !isRecord(value.entries)) return false;
  for (const provider of ["codex", "claude"] as const) {
    const entry = value.entries[provider];
    if (entry !== undefined && !isSharedCacheEntry(entry, provider)) return false;
  }
  if (value.backoffUntil !== undefined && !isProviderNumberMap(value.backoffUntil)) return false;
  if (value.refreshLeases !== undefined && !isRefreshLeaseMap(value.refreshLeases)) return false;
  return true;
}

export function readSharedUsageCache(): SharedUsageCache | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(runtime.cacheFile, "utf8"));
    return isSharedUsageCache(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** An acquired mutation lock. verify reasserts ownership just before the cache
 * is replaced; release is safe to call once, even after a failed verify. */
type MutationLock = { verify(): boolean; release(): void };

/** Retry acquire every MUTATION_LOCK_RETRY_MS for MUTATION_LOCK_ATTEMPTS tries
 * (a bounded wait of about 50ms), giving up on the last. */
function withBoundedRetry(tryOnce: () => boolean): boolean {
  for (let attempt = 0; attempt < MUTATION_LOCK_ATTEMPTS; attempt += 1) {
    if (tryOnce()) return true;
    if (attempt + 1 < MUTATION_LOCK_ATTEMPTS) Atomics.wait(mutationLockWaitArray, 0, 0, MUTATION_LOCK_RETRY_MS);
  }
  return false;
}

function tryAcquireMutationLock(): MutationLock | undefined {
  const backend = resolveMutationLockBackend();
  if (!backend) return undefined;

  try {
    mkdirSync(dirname(runtime.cacheFile), { recursive: true });
  } catch {
    return undefined;
  }
  return backend.kind === "flock" ? tryAcquireFlock(backend.flockSync) : tryAcquireSqliteLock(backend.Database);
}

/**
 * The lock path is a permanent rendezvous inode: this module never renames or
 * unlinks it. flock ownership belongs to the open file description, so the
 * kernel releases it on close or process death.
 */
function tryAcquireFlock(flockSync: FlockSync): MutationLock | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(`${runtime.cacheFile}.lock`, "a+");
    runtime.mutationLockPhase?.("after-open");
  } catch {
    return undefined;
  }

  const acquired = withBoundedRetry(() => {
    try {
      flockSync(descriptor, "exnb");
      return true;
    } catch {
      return false;
    }
  });
  if (!acquired) {
    try {
      closeSync(descriptor);
    } catch {
      // The descriptor may have failed independently of lock contention.
    }
    return undefined;
  }
  runtime.mutationLockPhase?.("after-acquire");
  return {
    verify() {
      try {
        // Reasserting LOCK_EX|LOCK_NB on the same open file description is an
        // atomic kernel ownership check. The descriptor remains locked across
        // the following rename, so there is no reusable-path check/use window.
        flockSync(descriptor, "exnb");
        return true;
      } catch {
        return false;
      }
    },
    release() {
      try {
        // Closing the open file description releases flock ownership even if
        // an explicit unlock would fail. A process crash does the same.
        closeSync(descriptor);
      } catch {
        // Best-effort: already closed, or closed when this process exits.
      }
    },
  };
}

/**
 * A separate rendezvous file from the flock inode, since the two lock kinds
 * never see each other. BEGIN EXCLUSIVE takes SQLite's exclusive lock (a POSIX
 * fcntl lock on the file); the kernel drops it when the connection closes or
 * the process dies. Nothing is ever written, so the file stays an empty
 * database and no journal is created.
 */
function tryAcquireSqliteLock(Database: SqliteDatabaseConstructor): MutationLock | undefined {
  let db: SqliteDatabase;
  try {
    // timeout 0: contention fails at once, and the bounded retry below waits.
    db = new Database(`${runtime.cacheFile}.lock.sqlite`, { timeout: 0 });
    runtime.mutationLockPhase?.("after-open");
  } catch {
    return undefined;
  }

  const acquired = withBoundedRetry(() => {
    try {
      db.exec("BEGIN EXCLUSIVE");
      return true;
    } catch {
      return false;
    }
  });
  if (!acquired) {
    try {
      db.close();
    } catch {
      // Already closed; the kernel holds nothing for this connection.
    }
    return undefined;
  }
  runtime.mutationLockPhase?.("after-acquire");
  return {
    // A live connection's exclusive lock cannot be taken from it, so holding
    // the transaction is holding the lock.
    verify: () => db.isTransaction !== false,
    release() {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Closing below ends the transaction and releases the lock anyway.
      }
      try {
        db.close();
      } catch {
        // Best-effort: closed when this process exits.
      }
    },
  };
}

function writeCacheAtomically(cacheFile: SharedUsageCache, lock: MutationLock): boolean {
  const tmpFile = `${runtime.cacheFile}.${process.pid}.${runtime.randomUUID()}.tmp`;
  try {
    writeFileSync(tmpFile, JSON.stringify(cacheFile));
    if (!lock.verify()) return false;
    runtime.mutationLockPhase?.("before-cache-replace");
    runtime.rename(tmpFile, runtime.cacheFile);
    runtime.mutationLockPhase?.("after-cache-replace");
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(tmpFile, { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}

type CacheMutation<T> = { changed: boolean; value: T };

function mutateSharedUsageCache<T>(fallback: T, mutate: (cacheFile: SharedUsageCache) => CacheMutation<T>): T {
  const lock = tryAcquireMutationLock();
  if (!lock) return fallback;
  try {
    const cacheFile = readSharedUsageCache() ?? { version: SHARED_CACHE_VERSION, entries: {} };
    const mutation = mutate(cacheFile);
    if (!mutation.changed) return mutation.value;
    return writeCacheAtomically(cacheFile, lock) ? mutation.value : fallback;
  } catch {
    return fallback;
  } finally {
    lock.release();
  }
}

export function saveSharedUsageReport(
  report: UsageReport,
  now: number = Date.now(),
  backoffProvider: UsageProviderKey = report.provider,
): void {
  if (!Number.isFinite(now)) return;
  mutateSharedUsageCache(undefined, (cacheFile) => {
    cacheFile.entries[report.provider] = { createdAt: now, report };
    if (cacheFile.backoffUntil) {
      delete cacheFile.backoffUntil[backoffProvider];
      if (Object.keys(cacheFile.backoffUntil).length === 0) cacheFile.backoffUntil = undefined;
    }
    return { changed: true, value: undefined };
  });
}

export function clearSharedUsageReport(provider: UsageProviderKey): void {
  mutateSharedUsageCache(undefined, (cacheFile) => {
    if (!cacheFile.entries[provider]) return { changed: false, value: undefined };
    delete cacheFile.entries[provider];
    return { changed: true, value: undefined };
  });
}

export function saveSharedBackoff(provider: UsageProviderKey, untilMs: number, now: number = Date.now()): void {
  if (!Number.isFinite(untilMs) || !Number.isFinite(now)) return;
  // Never persist a backoff further out than the max — protects against
  // clock skew between sessions producing absurd values.
  const clamped = Math.min(untilMs, now + RATE_LIMIT_BACKOFF_MAX_MS);
  mutateSharedUsageCache(undefined, (cacheFile) => {
    cacheFile.backoffUntil = { ...(cacheFile.backoffUntil ?? {}), [provider]: clamped };
    return { changed: true, value: undefined };
  });
}

export function clearSharedBackoff(): void {
  mutateSharedUsageCache(undefined, (cacheFile) => {
    if (cacheFile.backoffUntil === undefined) return { changed: false, value: undefined };
    cacheFile.backoffUntil = undefined;
    return { changed: true, value: undefined };
  });
}

export function sharedBackoffRemainingMs(provider: UsageProviderKey, now: number = Date.now()): number {
  try {
    const until = readSharedUsageCache()?.backoffUntil?.[provider] ?? 0;
    // Distrust stored timestamps: a skewed clock in another session must not
    // lock us out for hours. Cap the effective backoff at the configured max.
    return Math.min(until - now, RATE_LIMIT_BACKOFF_MAX_MS);
  } catch {
    return 0;
  }
}

export function isSharedCacheMutationAvailable(): boolean {
  return resolveMutationLockBackend() !== undefined;
}

export function tryAcquireRefreshLease(provider: UsageProviderKey, owner: string, now: number): boolean {
  const expiresAt = now + REFRESH_LEASE_MS;
  if (!owner || !Number.isFinite(now) || !Number.isFinite(expiresAt)) return false;
  return mutateSharedUsageCache(false, (cacheFile) => {
    const current = cacheFile.refreshLeases?.[provider];
    if (current && current.expiresAt > now) return { changed: false, value: false };
    cacheFile.refreshLeases = {
      ...(cacheFile.refreshLeases ?? {}),
      [provider]: { owner, expiresAt },
    };
    return { changed: true, value: true };
  });
}

export function renewRefreshLease(provider: UsageProviderKey, owner: string, now: number): boolean {
  if (!owner || !Number.isFinite(now)) return false;
  return mutateSharedUsageCache(false, (cacheFile) => {
    const current = cacheFile.refreshLeases?.[provider];
    if (!current || current.owner !== owner) return { changed: false, value: false };
    current.expiresAt = now + REFRESH_LEASE_MS;
    return { changed: true, value: true };
  });
}

export function releaseRefreshLease(provider: UsageProviderKey, owner: string): void {
  mutateSharedUsageCache(undefined, (cacheFile) => {
    const current = cacheFile.refreshLeases?.[provider];
    if (!current || current.owner !== owner) return { changed: false, value: undefined };
    delete cacheFile.refreshLeases?.[provider];
    if (cacheFile.refreshLeases && Object.keys(cacheFile.refreshLeases).length === 0) {
      cacheFile.refreshLeases = undefined;
    }
    return { changed: true, value: undefined };
  });
}

export function readFreshReportForModel(
  model: ProviderUsageModel | undefined,
  now: number,
): SharedCacheEntry | undefined {
  try {
    let best: SharedCacheEntry | undefined;
    for (const entry of Object.values(readSharedUsageCache()?.entries ?? {})) {
      if (!entry || !reportMatchesModel(entry.report, model)) continue;
      const ageMs = now - entry.createdAt;
      if (ageMs < 0 || ageMs >= CACHE_TTL_MS) continue;
      if (!best || entry.createdAt > best.createdAt) best = entry;
    }
    return best;
  } catch {
    return undefined;
  }
}

export type { SharedCacheEntry };
