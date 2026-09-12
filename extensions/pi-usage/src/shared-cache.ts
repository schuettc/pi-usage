import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  CACHE_TTL_MS,
  RATE_LIMIT_BACKOFF_MAX_MS,
  REFRESH_LEASE_MS,
  SHARED_CACHE_FILE,
  SHARED_CACHE_VERSION,
} from "./constants.js";
import { reportMatchesModel } from "./models.js";
import type { ProviderUsageModel, SharedCacheEntry, SharedUsageCache, UsageProviderKey, UsageReport } from "./types.js";

const MUTATION_LOCK_STALE_MS = 10_000;
const MUTATION_LOCK_RETRY_MS = 5;
const MUTATION_LOCK_ATTEMPTS = 11;
const mutationLockWaitArray = new Int32Array(new SharedArrayBuffer(4));

type SharedCacheRuntime = {
  cacheFile: string;
  now: () => number;
  rename: typeof renameSync;
  randomUUID: () => string;
};

const defaultRuntime: SharedCacheRuntime = {
  cacheFile: SHARED_CACHE_FILE,
  now: Date.now,
  rename: renameSync,
  randomUUID,
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
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string") return false;
  if (typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent)) return false;
  if (value.resetsAt !== undefined && (typeof value.resetsAt !== "number" || !Number.isFinite(value.resetsAt))) {
    return false;
  }
  if (
    value.windowMinutes !== undefined &&
    (typeof value.windowMinutes !== "number" || !Number.isFinite(value.windowMinutes))
  ) {
    return false;
  }
  if (!isRecord(value.scope)) return false;
  if (value.scope.kind === "account") return true;
  return (
    value.scope.kind === "model" &&
    typeof value.scope.label === "string" &&
    Array.isArray(value.scope.modelIds) &&
    value.scope.modelIds.every((modelId) => typeof modelId === "string")
  );
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

function isCodexSnapshot(value: unknown): boolean {
  if (!isRecord(value) || typeof value.limitId !== "string") return false;
  if (value.limitName !== undefined && typeof value.limitName !== "string") return false;
  if (value.primary !== undefined && !isCodexWindow(value.primary)) return false;
  if (value.secondary !== undefined && !isCodexWindow(value.secondary)) return false;
  return value.credits === undefined || isRecord(value.credits);
}

function isUsageReport(value: unknown, provider: UsageProviderKey): value is UsageReport {
  if (!isRecord(value) || value.provider !== provider) return false;
  if (typeof value.capturedAt !== "number" || !Number.isFinite(value.capturedAt)) return false;

  if (value.source === "external-adapter") {
    return (
      Array.isArray(value.modelProviders) &&
      value.modelProviders.every((modelProvider) => typeof modelProvider === "string") &&
      Array.isArray(value.windows) &&
      value.windows.every(isNormalizedWindow)
    );
  }
  if (provider === "anthropic" && value.source === "anthropic-oauth") {
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
  return (["codex", "anthropic"] as const).every((provider) => {
    const item = value[provider];
    return item === undefined || (typeof item === "number" && Number.isFinite(item));
  });
}

function isRefreshLeaseMap(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (["codex", "anthropic"] as const).every((provider) => {
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
  for (const provider of ["codex", "anthropic"] as const) {
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

type MutationLock = { lockFile: string; owner: string };

function recoverStaleMutationLock(lockFile: string): boolean {
  try {
    const ageMs = runtime.now() - statSync(lockFile).mtimeMs;
    if (!Number.isFinite(ageMs) || ageMs <= MUTATION_LOCK_STALE_MS) return false;
    const staleFile = `${lockFile}.stale.${process.pid}.${runtime.randomUUID()}`;
    runtime.rename(lockFile, staleFile);
    rmSync(staleFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

function tryAcquireMutationLock(): MutationLock | undefined {
  const lockFile = `${runtime.cacheFile}.lock`;
  try {
    mkdirSync(dirname(runtime.cacheFile), { recursive: true });
  } catch {
    return undefined;
  }

  let staleRecoveryAttempted = false;
  for (let attempt = 0; attempt < MUTATION_LOCK_ATTEMPTS; attempt += 1) {
    const owner = `${process.pid}:${runtime.randomUUID()}`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(lockFile, "wx");
      writeFileSync(descriptor, JSON.stringify({ owner, acquiredAt: runtime.now() }));
      closeSync(descriptor);
      return { lockFile, owner };
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // The descriptor may already have been closed after a successful write.
        }
        try {
          unlinkSync(lockFile);
        } catch {
          // Best-effort cleanup.
        }
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") return undefined;
      if (!staleRecoveryAttempted) {
        staleRecoveryAttempted = true;
        if (recoverStaleMutationLock(lockFile)) continue;
      }
      if (attempt + 1 >= MUTATION_LOCK_ATTEMPTS) return undefined;
      Atomics.wait(mutationLockWaitArray, 0, 0, MUTATION_LOCK_RETRY_MS);
    }
  }
  return undefined;
}

function releaseMutationLock(lock: MutationLock): void {
  try {
    const contents: unknown = JSON.parse(readFileSync(lock.lockFile, "utf8"));
    if (!isRecord(contents) || contents.owner !== lock.owner) return;
    unlinkSync(lock.lockFile);
  } catch {
    // Best-effort — a stale lock is recovered by a later bounded acquisition.
  }
}

function writeCacheAtomically(cacheFile: SharedUsageCache): boolean {
  const tmpFile = `${runtime.cacheFile}.${process.pid}.${runtime.randomUUID()}.tmp`;
  try {
    writeFileSync(tmpFile, JSON.stringify(cacheFile));
    runtime.rename(tmpFile, runtime.cacheFile);
    return true;
  } catch {
    try {
      rmSync(tmpFile, { force: true });
    } catch {
      // Best-effort cleanup.
    }
    return false;
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
    return writeCacheAtomically(cacheFile) ? mutation.value : fallback;
  } catch {
    return fallback;
  } finally {
    releaseMutationLock(lock);
  }
}

export function saveSharedUsageReport(report: UsageReport, now: number = Date.now()): void {
  if (!Number.isFinite(now)) return;
  mutateSharedUsageCache(undefined, (cacheFile) => {
    cacheFile.entries[report.provider] = { createdAt: now, report };
    if (cacheFile.backoffUntil) {
      delete cacheFile.backoffUntil[report.provider];
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
