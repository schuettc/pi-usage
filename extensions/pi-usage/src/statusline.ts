import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getUsageBusV1 } from "./adapter-bus.js";
import {
  ANTHROPIC_PROVIDER_ID,
  CACHE_TTL_MS,
  CODEX_PROVIDER_ID,
  DEFAULT_TIMEOUT_MS,
  REFRESH_LEASE_MS,
  STATUS_KEY,
} from "./constants.js";
import { isRateLimitErrorMessage, isStaleExtensionContextError, rateLimitBackoffMs } from "./errors.js";
import { formatUsageStatusline } from "./format.js";
import { isUsageSupportedModel, providerKeyForModel, reportMatchesModel } from "./models.js";
import { normalizeExternalUsageSnapshot } from "./normalize-external.js";
import { queryUsageWithRetries } from "./query.js";
import {
  readFreshReportForModel,
  readSharedUsageCache,
  releaseRefreshLease,
  saveSharedBackoff,
  saveSharedUsageReport,
  sharedBackoffRemainingMs,
  tryAcquireRefreshLease,
} from "./shared-cache.js";
import type {
  CachedReport,
  ProviderUsageModel,
  ProviderUsageSnapshotV1,
  QueryUsageResult,
  UsageReport,
} from "./types.js";
import { formatAgeShort } from "./utils.js";

type StatuslineTimer = ReturnType<typeof setTimeout>;
type StatuslineRuntime = {
  now: () => number;
  queryUsage: (ctx: ExtensionContext, options: { timeoutMs: number }) => Promise<QueryUsageResult>;
  setTimeout: (callback: () => void, delayMs: number) => StatuslineTimer;
  clearTimeout: (timer: StatuslineTimer) => void;
};

const defaultRuntime: StatuslineRuntime = {
  now: Date.now,
  queryUsage: queryUsageWithRetries,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};
const refreshLeaseOwner = `${process.pid}:${randomUUID()}`;
let runtime = defaultRuntime;
let cache: CachedReport | undefined;
let combinedCache: { createdAt: number; reports: UsageReport[] } | undefined;
let statuslineClearTimer: StatuslineTimer | undefined;
let statuslineRefreshTimer: StatuslineTimer | undefined;
let statuslineRequestId = 0;
let sessionActive = false;
let activeStatuslineContext: ExtensionContext | undefined;
let activeModelProvider: string | undefined;

export function isSessionActive(): boolean {
  return sessionActive;
}

export function setSessionActive(value: boolean): void {
  sessionActive = value;
}

export function getCombinedCache(): { createdAt: number; reports: UsageReport[] } | undefined {
  return combinedCache;
}

export function setCombinedCache(value: { createdAt: number; reports: UsageReport[] } | undefined): void {
  combinedCache = value;
}

export function clearCodexMemoryCache(): void {
  cache = undefined;
}

const clearStatuslineTimers = () => {
  if (statuslineClearTimer) runtime.clearTimeout(statuslineClearTimer);
  if (statuslineRefreshTimer) runtime.clearTimeout(statuslineRefreshTimer);
  statuslineClearTimer = undefined;
  statuslineRefreshTimer = undefined;
};

/** Replaces clock, query, and timer behavior while resetting module state.
 * This keeps tests off the real cache/network without changing production use. */
export function configureStatuslineForTests(overrides: Partial<StatuslineRuntime> = {}): void {
  clearStatuslineTimers();
  runtime = { ...defaultRuntime, ...overrides };
  cache = undefined;
  combinedCache = undefined;
  statuslineRequestId = 0;
  sessionActive = false;
  activeStatuslineContext = undefined;
  activeModelProvider = undefined;
}

export function handleStaleContextError(ctx: ExtensionContext, error: unknown): boolean {
  if (!isStaleExtensionContextError(error)) return false;
  if (ctx === activeStatuslineContext) {
    statuslineRequestId += 1;
    clearStatuslineTimers();
    activeStatuslineContext = undefined;
    activeModelProvider = undefined;
  }
  return true;
}

export const rethrowUnlessStaleContextError = (ctx: ExtensionContext) => (error: unknown) => {
  if (!handleStaleContextError(ctx, error)) throw error;
};

const setStatuslineValue = (ctx: ExtensionContext, value: string | undefined): boolean => {
  try {
    ctx.ui.setStatus(STATUS_KEY, value);
    return true;
  } catch (error) {
    if (handleStaleContextError(ctx, error)) return false;
    throw error;
  }
};

export function clearUsageStatusline(ctx: ExtensionContext): void {
  statuslineRequestId += 1;
  clearStatuslineTimers();
  activeStatuslineContext = undefined;
  activeModelProvider = undefined;
  setStatuslineValue(ctx, undefined);
}

const scheduleTemporaryStatuslineClear = (ctx: ExtensionContext) => {
  if (statuslineClearTimer) runtime.clearTimeout(statuslineClearTimer);
  const requestId = statuslineRequestId;
  statuslineClearTimer = runtime.setTimeout(() => {
    statuslineClearTimer = undefined;
    if (!sessionActive || requestId !== statuslineRequestId) return;
    setStatuslineValue(ctx, undefined);
  }, CACHE_TTL_MS);
  statuslineClearTimer.unref?.();
};

const scheduleStatuslineRefresh = (
  ctx: ExtensionContext,
  model: ProviderUsageModel | undefined,
  delayMs: number = CACHE_TTL_MS,
) => {
  if (statuslineRefreshTimer) runtime.clearTimeout(statuslineRefreshTimer);
  const requestId = statuslineRequestId;
  statuslineRefreshTimer = runtime.setTimeout(
    () => {
      statuslineRefreshTimer = undefined;
      if (!sessionActive || requestId !== statuslineRequestId) return;
      void refreshCurrentUsageStatusline(ctx, model).catch(rethrowUnlessStaleContextError(ctx));
    },
    Math.max(0, delayMs),
  );
  statuslineRefreshTimer.unref?.();
};

const setUsageStatusline = (
  ctx: ExtensionContext,
  report: UsageReport,
  options: {
    autoRefresh: boolean;
    model: ProviderUsageModel | undefined;
    staleAgeMs?: number;
    refreshDelayMs?: number;
    schedule?: boolean;
  },
): boolean => {
  let text = formatUsageStatusline(report, options.model);
  if (text === undefined) {
    setStatuslineValue(ctx, undefined);
    return false;
  }
  if (options.staleAgeMs !== undefined && options.staleAgeMs >= CACHE_TTL_MS) {
    text = `${text} (${formatAgeShort(options.staleAgeMs)} old)`;
  }
  if (!setStatuslineValue(ctx, text)) return false;
  activeStatuslineContext = ctx;
  if (statuslineClearTimer) runtime.clearTimeout(statuslineClearTimer);
  statuslineClearTimer = undefined;
  if (options.schedule === false) return true;
  if (options.autoRefresh) scheduleStatuslineRefresh(ctx, options.model, options.refreshDelayMs);
  else scheduleTemporaryStatuslineClear(ctx);
  return true;
};

const getCachedReportForModel = (model: ProviderUsageModel | undefined, now: number): CachedReport | undefined => {
  try {
    let best = cache && reportMatchesModel(cache.report, model) ? cache : undefined;
    if (combinedCache) {
      const report = combinedCache.reports.find((item) => reportMatchesModel(item, model));
      if (report) {
        const candidate = { createdAt: combinedCache.createdAt, report };
        if (!best || candidate.createdAt > best.createdAt) best = candidate;
      }
    }

    // Another pi session may have fetched more recently — use its data. The
    // freshness helper is the fast path; the raw read retains stale data for
    // display while a coordinated refresh is in flight.
    let shared = readFreshReportForModel(model, now);
    for (const entry of Object.values(readSharedUsageCache()?.entries ?? {})) {
      if (!entry?.report || !reportMatchesModel(entry.report, model)) continue;
      if (!shared || entry.createdAt > shared.createdAt) shared = entry;
    }
    if (shared && (!best || shared.createdAt > best.createdAt)) best = shared;
    return best;
  } catch {
    return cache && reportMatchesModel(cache.report, model) ? cache : undefined;
  }
};

function clearRefreshTimer(): void {
  if (!statuslineRefreshTimer) return;
  runtime.clearTimeout(statuslineRefreshTimer);
  statuslineRefreshTimer = undefined;
}

export async function refreshCurrentUsageStatusline(ctx: ExtensionContext, model?: ProviderUsageModel): Promise<void> {
  if (!sessionActive) return;
  activeStatuslineContext = ctx;
  const selectedModel = model ?? ctx.model;
  if (!selectedModel || !isUsageSupportedModel(selectedModel)) {
    clearUsageStatusline(ctx);
    return;
  }

  if (activeModelProvider !== undefined && activeModelProvider !== selectedModel.provider) {
    statuslineRequestId += 1;
    clearStatuslineTimers();
    if (!setStatuslineValue(ctx, undefined)) return;
  } else {
    clearRefreshTimer();
  }
  activeModelProvider = selectedModel.provider;

  const requestId = statuslineRequestId + 1;
  statuslineRequestId = requestId;
  const now = runtime.now();
  const cached = getCachedReportForModel(selectedModel, now);
  const cacheAgeMs = cached ? now - cached.createdAt : Number.POSITIVE_INFINITY;
  const freshCached = cached && cacheAgeMs >= 0 && cacheAgeMs < CACHE_TTL_MS ? cached : undefined;
  // Fresh cache is always good enough — avoids double-fetching when /usage
  // just updated it or another pi session already fetched. The scheduled
  // timer fires when the TTL actually expires.
  if (freshCached) {
    setUsageStatusline(ctx, freshCached.report, {
      autoRefresh: true,
      model: selectedModel,
      refreshDelayMs: CACHE_TTL_MS - cacheAgeMs,
    });
    return;
  }

  // Respect a shared rate-limit backoff set by any session.
  const providerKey = providerKeyForModel(selectedModel);
  const backoffRemaining = sharedBackoffRemainingMs(providerKey, now);
  if (backoffRemaining > 0) {
    if (cached) {
      setUsageStatusline(ctx, cached.report, {
        autoRefresh: true,
        model: selectedModel,
        staleAgeMs: Math.max(0, now - cached.report.capturedAt),
        refreshDelayMs: Math.max(backoffRemaining, 10_000),
      });
    } else if (setStatuslineValue(ctx, `usage rate-limited (${formatAgeShort(backoffRemaining)})`)) {
      scheduleStatuslineRefresh(ctx, selectedModel, Math.max(backoffRemaining, 10_000));
    }
    return;
  }

  // The mutation lock used inside this call is released before any provider
  // work starts. The persisted lease remains visible to other processes.
  if (!tryAcquireRefreshLease(providerKey, refreshLeaseOwner, now)) {
    const leaseExpiry = readSharedUsageCache()?.refreshLeases?.[providerKey]?.expiresAt;
    const retryDelayMs = Math.max(1, (leaseExpiry ?? now + REFRESH_LEASE_MS) - now);
    if (cached) {
      setUsageStatusline(ctx, cached.report, {
        autoRefresh: true,
        model: selectedModel,
        staleAgeMs: Math.max(0, now - cached.report.capturedAt),
        refreshDelayMs: retryDelayMs,
      });
    } else if (setStatuslineValue(ctx, "checking")) {
      scheduleStatuslineRefresh(ctx, selectedModel, retryDelayMs);
    }
    return;
  }

  let result: QueryUsageResult;
  let rateLimited = false;
  let retryDelayMs = CACHE_TTL_MS;
  try {
    if (cached) {
      if (
        !setUsageStatusline(ctx, cached.report, {
          autoRefresh: true,
          model: selectedModel,
          staleAgeMs: Math.max(0, now - cached.report.capturedAt),
          schedule: false,
        })
      ) {
        return;
      }
    } else if (!setStatuslineValue(ctx, "checking")) {
      return;
    }

    result = await runtime.queryUsage(ctx, { timeoutMs: DEFAULT_TIMEOUT_MS });
    const completedAt = runtime.now();
    if (result.ok) {
      cache = { createdAt: completedAt, report: result.report };
      saveSharedUsageReport(result.report, completedAt);
    } else {
      rateLimited = result.errors.some((error) => isRateLimitErrorMessage(error.message));
      // Honor the server's Retry-After when it sends one; fall back to default.
      retryDelayMs = rateLimited ? rateLimitBackoffMs(result.errors) : CACHE_TTL_MS;
      if (rateLimited) saveSharedBackoff(providerKey, completedAt + retryDelayMs, completedAt);
    }
  } finally {
    releaseRefreshLease(providerKey, refreshLeaseOwner);
  }

  if (!sessionActive || requestId !== statuslineRequestId) return;

  if (!result.ok) {
    // Background refreshes fail silently — the statusline text is the only
    // indicator. Detailed errors are shown when /usage is run explicitly.
    if (cached) {
      setUsageStatusline(ctx, cached.report, {
        autoRefresh: true,
        model: selectedModel,
        staleAgeMs: Math.max(0, runtime.now() - cached.report.capturedAt),
        refreshDelayMs: retryDelayMs,
      });
      return;
    }
    const errorLabel = rateLimited ? `usage rate-limited (${formatAgeShort(retryDelayMs)})` : "usage error";
    if (setStatuslineValue(ctx, errorLabel)) {
      scheduleStatuslineRefresh(ctx, selectedModel, retryDelayMs);
    }
    return;
  }

  setUsageStatusline(ctx, result.report, { autoRefresh: true, model: selectedModel });
}

export function applyCurrentProviderStatusline(ctx: ExtensionContext, reports: UsageReport[]): boolean {
  const current = reports.find((report) => reportMatchesModel(report, ctx.model));
  if (!current) {
    setStatuslineValue(ctx, undefined);
    return false;
  }
  cache = { createdAt: runtime.now(), report: current };
  activeModelProvider = ctx.model?.provider;
  setUsageStatusline(ctx, current, {
    autoRefresh: isUsageSupportedModel(ctx.model),
    model: ctx.model,
  });
  return true;
}

/** Normalizes an adapter bus snapshot, persists it, and immediately applies it
 * when it matches the selected model. Task 6 owns bus subscription lifecycle. */
export function applyProviderUsageSnapshot(ctx: ExtensionContext, snapshot: ProviderUsageSnapshotV1): boolean {
  try {
    const selectedAdapter = getUsageBusV1()
      .adapters()
      .find((adapter) => ctx.model !== undefined && adapter.modelProviders.includes(ctx.model.provider));
    const nativeProvider = snapshot.provider === "anthropic" ? ANTHROPIC_PROVIDER_ID : CODEX_PROVIDER_ID;
    const modelProviders = [...new Set([...(selectedAdapter?.modelProviders ?? []), nativeProvider])];
    const report = normalizeExternalUsageSnapshot(snapshot, modelProviders);
    const now = runtime.now();
    saveSharedUsageReport(report, now);
    if (!reportMatchesModel(report, ctx.model)) return false;

    statuslineRequestId += 1;
    clearStatuslineTimers();
    cache = { createdAt: now, report };
    activeModelProvider = ctx.model?.provider;
    return applyCurrentProviderStatusline(ctx, [report]);
  } catch {
    return false;
  }
}

export const applyProviderUsageSnapshotToStatusline = applyProviderUsageSnapshot;

export function setStatuslineChecking(ctx: ExtensionContext): boolean {
  return setStatuslineValue(ctx, "checking");
}

export function clearStatuslineValue(ctx: ExtensionContext): boolean {
  return setStatuslineValue(ctx, undefined);
}
