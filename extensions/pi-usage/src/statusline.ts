import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  adapterForReport,
  currentAccountForAdapter,
  getUsageAdaptersV1,
  resolveReportAccountLabel,
} from "./adapter-bus.js";
import {
  ANTHROPIC_PROVIDER_ID,
  CACHE_TTL_MS,
  CODEX_PROVIDER_ID,
  DEFAULT_TIMEOUT_MS,
  REFRESH_LEASE_MS,
  STATUS_KEY,
  USAGE_UNAVAILABLE_TEXT,
} from "./constants.js";
import { isRateLimitErrorMessage, isStaleExtensionContextError, rateLimitBackoffMs } from "./errors.js";
import { formatUsageStatusline } from "./format.js";
import {
  isAnthropicModel,
  isOpenAICodexModel,
  isUsageSupportedModel,
  providerKeyForModel,
  reportMatchesModel,
} from "./models.js";
import { normalizeExternalUsageSnapshot } from "./normalize-external.js";
import { queryUsageWithRetries } from "./query.js";
import {
  cacheKeyFor,
  isSharedCacheMutationAvailable,
  readFreshReportForModel,
  readSharedUsageCache,
  releaseRefreshLease,
  renewRefreshLease,
  saveSharedBackoff,
  saveSharedUsageReport,
  sharedBackoffRemainingMs,
  tryAcquireRefreshLease,
} from "./shared-cache.js";
import type {
  CachedReport,
  ProviderUsageAdapterV1,
  ProviderUsageModel,
  ProviderUsageSnapshotV1,
  QueryUsageResult,
  UsageAccountV1,
  UsageProviderKey,
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
let statuslineCountdownTimer: StatuslineTimer | undefined;
let statuslineRequestId = 0;
let sessionActive = false;
let activeStatuslineContext: ExtensionContext | undefined;
let activeModelProvider: string | undefined;
const activeRefreshProviders = new Set<UsageProviderKey>();

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
  if (statuslineCountdownTimer) runtime.clearTimeout(statuslineCountdownTimer);
  statuslineClearTimer = undefined;
  statuslineRefreshTimer = undefined;
  statuslineCountdownTimer = undefined;
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
  activeRefreshProviders.clear();
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

const scheduleCountdownRerender = (
  ctx: ExtensionContext,
  report: UsageReport,
  model: ProviderUsageModel | undefined,
  stale: boolean,
) => {
  if (statuslineCountdownTimer) runtime.clearTimeout(statuslineCountdownTimer);
  const requestId = statuslineRequestId;
  const rerender = () => {
    statuslineCountdownTimer = undefined;
    if (!sessionActive || requestId !== statuslineRequestId) return;
    if (model && reportAccountHasChanged(report, model)) {
      if (setStatuslineValue(ctx, "checking")) {
        void refreshCurrentUsageStatusline(ctx, model).catch(rethrowUnlessStaleContextError(ctx));
      }
      return;
    }
    let text = renderStatuslineText(report, model);
    if (text === undefined) return;
    if (stale) text = `${text} (${formatAgeShort(Math.max(0, runtime.now() - report.capturedAt))} old)`;
    if (!setStatuslineValue(ctx, text)) return;
    statuslineCountdownTimer = runtime.setTimeout(rerender, 60_000);
    statuslineCountdownTimer.unref?.();
  };
  statuslineCountdownTimer = runtime.setTimeout(rerender, 60_000);
  statuslineCountdownTimer.unref?.();
};

const setUsageStatusline = (
  ctx: ExtensionContext,
  report: UsageReport,
  options: {
    autoRefresh: boolean;
    model: ProviderUsageModel | undefined;
    staleAgeMs?: number;
    forceStale?: boolean;
    refreshDelayMs?: number;
    schedule?: boolean;
  },
): boolean => {
  let text = renderStatuslineText(report, options.model);
  if (text === undefined) {
    setStatuslineValue(ctx, undefined);
    return false;
  }
  const stale = options.forceStale === true || (options.staleAgeMs !== undefined && options.staleAgeMs >= CACHE_TTL_MS);
  if (stale) text = `${text} (${formatAgeShort(options.staleAgeMs as number)} old)`;
  if (!setStatuslineValue(ctx, text)) return false;
  activeStatuslineContext = ctx;
  if (statuslineClearTimer) runtime.clearTimeout(statuslineClearTimer);
  statuslineClearTimer = undefined;
  scheduleCountdownRerender(ctx, report, options.model, stale);
  if (options.schedule === false) return true;
  if (options.autoRefresh) scheduleStatuslineRefresh(ctx, options.model, options.refreshDelayMs);
  else scheduleTemporaryStatuslineClear(ctx);
  return true;
};

/** Prefer a native report (always `complete`) over a broken/partial
 * external-adapter one, THEN break ties by recency. The bridge's partial 5h
 * events refresh often, so newest-wins alone would let them shadow the accurate
 * native OAuth report — this keeps native winning even when it is slightly
 * older. */
function isPreferredOver(candidate: CachedReport, current: CachedReport): boolean {
  const candidateIsExternal = candidate.report.source === "external-adapter";
  const currentIsExternal = current.report.source === "external-adapter";
  if (candidateIsExternal !== currentIsExternal) return !candidateIsExternal;
  return candidate.createdAt > current.createdAt;
}

/** The adapter registered for a model's provider, if any. Models backed
 * natively (Anthropic OAuth, Codex) have no bus adapter. */
function adapterForModel(model: ProviderUsageModel | undefined): ProviderUsageAdapterV1 | undefined {
  if (!model) return undefined;
  return getUsageAdaptersV1().find((adapter) => adapter.modelProviders.includes(model.provider));
}

/** The one rule for whether `report` still belongs to `currentAccount`: a
 * native report always does, and an external-adapter report does when it has
 * no `currentAccount` to compare against (the adapter has no opinion) or its
 * account id matches. An account-less external-adapter report is NOT treated
 * as belonging once an adapter resolves a current account at all — that
 * adapter now tracks accounts, so a report with no account predates that and
 * must be treated as stale/filtered, same as a report for a different id. */
function reportBelongsToAccount(report: UsageReport, currentAccount: UsageAccountV1 | undefined): boolean {
  if (report.source !== "external-adapter") return true;
  if (!currentAccount) return true;
  return report.account?.id === currentAccount.id;
}

/** Whether a report must be hidden because it was measured for a different
 * account than the one the model's adapter is about to use next. An adapter
 * that cannot say which account is current never filters anything out — this
 * is strictly additive to pre-account-aware behavior. */
function reportAccountHasChanged(report: UsageReport, model: ProviderUsageModel | undefined): boolean {
  if (report.source !== "external-adapter") return false;
  const adapter = adapterForModel(model);
  if (!adapter) return false;
  const currentAccount = currentAccountForAdapter(adapter.id);
  if (!currentAccount) return false;
  return !reportBelongsToAccount(report, currentAccount);
}

function reportMatchesCurrentAccount(report: UsageReport, currentAccountId: string | undefined): boolean {
  if (report.source !== "external-adapter") return true;
  if (currentAccountId === undefined) return true;
  return report.account?.id === currentAccountId;
}

/** Drops any external-adapter report whose account no longer matches its
 * adapter's current account. The single filter every `/usage`-command and
 * statusline display path must go through before a report list is shown or
 * retained as a stale fallback — see `reportMatchesCurrentAccount` above for
 * the per-model variant used while a specific model is already selected. */
export function reportsForCurrentAccounts(reports: UsageReport[]): UsageReport[] {
  return reports.filter((report) => {
    if (report.source !== "external-adapter") return true;
    const adapter = adapterForReport(report);
    if (!adapter) return true;
    const currentAccount = currentAccountForAdapter(adapter.id);
    return reportBelongsToAccount(report, currentAccount);
  });
}

const getCachedReportForModel = (
  model: ProviderUsageModel | undefined,
  now: number,
  currentAccountId: string | undefined,
): CachedReport | undefined => {
  const matchesAccount = (report: UsageReport) => reportMatchesCurrentAccount(report, currentAccountId);
  try {
    let best = cache && reportMatchesModel(cache.report, model) && matchesAccount(cache.report) ? cache : undefined;
    if (combinedCache) {
      const report = combinedCache.reports.find((item) => reportMatchesModel(item, model) && matchesAccount(item));
      if (report) {
        const candidate = { createdAt: combinedCache.createdAt, report };
        if (!best || isPreferredOver(candidate, best)) best = candidate;
      }
    }

    // Another pi session may have fetched more recently — use its data. The
    // freshness helper is the fast path; the raw read retains stale data for
    // display while a coordinated refresh is in flight.
    let shared = readFreshReportForModel(model, now, matchesAccount);
    for (const entry of Object.values(readSharedUsageCache()?.entries ?? {})) {
      if (!entry?.report || !reportMatchesModel(entry.report, model) || !matchesAccount(entry.report)) continue;
      if (!shared || isPreferredOver(entry, shared)) shared = entry;
    }
    if (shared && (!best || isPreferredOver(shared, best))) best = shared;
    return best;
  } catch {
    return cache && reportMatchesModel(cache.report, model) && matchesAccount(cache.report) ? cache : undefined;
  }
};

/** Renders the statusline text and, for an external-adapter report, tags it
 * with the account the usage was measured against: the report's own account
 * label, else the label the adapter now gives that same account id, else no
 * label at all. Resolved at render time and NEVER persisted to the cache or
 * report objects. */
function renderStatuslineText(report: UsageReport, model: ProviderUsageModel | undefined): string | undefined {
  const text = formatUsageStatusline(report, model);
  if (text === undefined || text === USAGE_UNAVAILABLE_TEXT) return text;
  const label = resolveReportAccountLabel(report);
  if (!label) return text;
  const match = text.match(/^(\S+)([\s\S]*)$/);
  if (!match) return text;
  return `${match[1]}(${label})${match[2]}`;
}

function clearRefreshTimer(): void {
  if (!statuslineRefreshTimer) return;
  runtime.clearTimeout(statuslineRefreshTimer);
  statuslineRefreshTimer = undefined;
}

function usageProviderForModel(model: ProviderUsageModel): UsageProviderKey {
  if (isAnthropicModel(model) || isOpenAICodexModel(model)) {
    return providerKeyForModel(model);
  }
  return adapterForModel(model)?.usageProvider ?? providerKeyForModel(model);
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
  const selectedAdapterForAccount = adapterForModel(selectedModel);
  const currentAccount = selectedAdapterForAccount && currentAccountForAdapter(selectedAdapterForAccount.id);
  const cached = getCachedReportForModel(selectedModel, now, currentAccount?.id);
  const cacheAgeMs = cached ? now - cached.createdAt : Number.POSITIVE_INFINITY;
  const cacheIsComplete = cached?.report.source !== "external-adapter" || cached.report.complete;
  const freshCached = cached && cacheIsComplete && cacheAgeMs >= 0 && cacheAgeMs < CACHE_TTL_MS ? cached : undefined;
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

  // Resolve external adapters to their semantic usage provider before any
  // backoff or lease decision. Model provider IDs alone are not sufficient.
  const providerKey = usageProviderForModel(selectedModel);
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
  // work starts. The persisted lease remains visible to other processes. The
  // in-memory fence outlives the persisted lease so a long poll cannot
  // reacquire with this process-wide owner and later release its newer lease.
  const activeInThisProcess = activeRefreshProviders.has(providerKey);
  const coordinated = isSharedCacheMutationAvailable();
  const leaseAcquired =
    coordinated && !activeInThisProcess ? tryAcquireRefreshLease(providerKey, refreshLeaseOwner, now) : false;
  if (activeInThisProcess || (coordinated && !leaseAcquired)) {
    const leaseExpiry = readSharedUsageCache()?.refreshLeases?.[providerKey]?.expiresAt;
    const retryDelayMs =
      activeInThisProcess && (leaseExpiry === undefined || leaseExpiry <= now)
        ? REFRESH_LEASE_MS
        : Math.max(10_000, (leaseExpiry ?? now + REFRESH_LEASE_MS) - now);
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

  activeRefreshProviders.add(providerKey);
  let leaseRenewalTimer: StatuslineTimer | undefined;
  const scheduleLeaseRenewal = () => {
    if (!leaseAcquired) return;
    leaseRenewalTimer = runtime.setTimeout(() => {
      renewRefreshLease(providerKey, refreshLeaseOwner, runtime.now());
      scheduleLeaseRenewal();
    }, 10_000);
    leaseRenewalTimer.unref?.();
  };
  scheduleLeaseRenewal();
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
      saveSharedUsageReport(result.report, completedAt, providerKey);
    } else {
      rateLimited = result.errors.some((error) => isRateLimitErrorMessage(error.message));
      // Honor the server's Retry-After when it sends one; fall back to default.
      retryDelayMs = rateLimited ? rateLimitBackoffMs(result.errors) : CACHE_TTL_MS;
      if (rateLimited) saveSharedBackoff(providerKey, completedAt + retryDelayMs, completedAt);
    }
  } finally {
    if (leaseRenewalTimer) runtime.clearTimeout(leaseRenewalTimer);
    if (leaseAcquired) releaseRefreshLease(providerKey, refreshLeaseOwner);
    activeRefreshProviders.delete(providerKey);
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

export function applyCurrentProviderStatusline(
  ctx: ExtensionContext,
  reports: UsageReport[],
  cached?: { createdAt: number; stale: boolean },
): boolean {
  const current = reportsForCurrentAccounts(reports).find((report) => reportMatchesModel(report, ctx.model));
  if (!current) {
    setStatuslineValue(ctx, undefined);
    return false;
  }
  cache = { createdAt: cached?.createdAt ?? runtime.now(), report: current };
  activeModelProvider = ctx.model?.provider;
  setUsageStatusline(ctx, current, {
    autoRefresh: isUsageSupportedModel(ctx.model),
    model: ctx.model,
    ...(cached ? { staleAgeMs: Math.max(0, runtime.now() - cached.createdAt), forceStale: cached.stale } : {}),
  });
  return true;
}

/** Normalizes an adapter bus snapshot, persists it, and immediately applies it
 * when it matches the selected model. */
export function applyProviderUsageSnapshot(ctx: ExtensionContext, snapshot: ProviderUsageSnapshotV1): boolean {
  try {
    const adapters = getUsageAdaptersV1();
    const selectedAdapter =
      (snapshot.adapterId ? adapters.find((adapter) => adapter.id === snapshot.adapterId) : undefined) ??
      adapters.find(
        (adapter) =>
          adapter.usageProvider === snapshot.provider &&
          ctx.model !== undefined &&
          adapter.modelProviders.includes(ctx.model.provider),
      );
    if (selectedAdapter && selectedAdapter.usageProvider !== snapshot.provider) return false;
    const previous = findPreviousAdapterReport(
      snapshot.provider,
      snapshot.adapterId ?? selectedAdapter?.id,
      snapshot.account?.id,
    );
    // An adapter report matches only its own modelProviders — adding the
    // native provider here would let it bleed into native model selection
    // for every account, not just the one it was measured on. The native
    // provider is only a last-resort fallback so the array is never empty
    // when no adapter could be matched at all.
    const nativeProvider = snapshot.provider === "claude" ? ANTHROPIC_PROVIDER_ID : CODEX_PROVIDER_ID;
    const matchedModelProviders = [
      ...new Set([...(previous?.modelProviders ?? []), ...(selectedAdapter?.modelProviders ?? [])]),
    ];
    const modelProviders = matchedModelProviders.length > 0 ? matchedModelProviders : [nativeProvider];
    const normalized = normalizeExternalUsageSnapshot(
      snapshot.adapterId === undefined && selectedAdapter ? { ...snapshot, adapterId: selectedAdapter.id } : snapshot,
      modelProviders,
    );
    const report = !normalized.complete && previous ? mergePartialAdapterReport(previous, normalized) : normalized;
    const now = runtime.now();
    const retainedReports = (combinedCache?.reports ?? []).filter(
      (candidate) =>
        candidate.source !== "external-adapter" ||
        candidate.provider !== report.provider ||
        candidate.adapterId !== report.adapterId ||
        candidate.account?.id !== report.account?.id,
    );
    combinedCache = { createdAt: now, reports: [...retainedReports, report] };
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

function findPreviousAdapterReport(
  provider: UsageProviderKey,
  adapterId: string | undefined,
  accountId: string | undefined,
): Extract<UsageReport, { source: "external-adapter" }> | undefined {
  const reports = [
    cache?.report,
    ...(combinedCache?.reports ?? []),
    readSharedUsageCache()?.entries[cacheKeyFor(provider, accountId)]?.report,
  ];
  return reports.find(
    (report): report is Extract<UsageReport, { source: "external-adapter" }> =>
      report?.source === "external-adapter" &&
      report.provider === provider &&
      (adapterId === undefined || report.adapterId === adapterId) &&
      report.account?.id === accountId,
  );
}

function mergePartialAdapterReport(
  previous: Extract<UsageReport, { source: "external-adapter" }>,
  partial: Extract<UsageReport, { source: "external-adapter" }>,
): Extract<UsageReport, { source: "external-adapter" }> {
  const merged = new Map(previous.windows.map((window) => [usageWindowIdentity(window), window]));
  for (const window of partial.windows) {
    const identity = usageWindowIdentity(window);
    merged.set(identity, { ...(merged.get(identity) ?? {}), ...window });
  }
  return {
    ...partial,
    providerLabel: partial.providerLabel ?? previous.providerLabel,
    adapterId: partial.adapterId ?? previous.adapterId,
    modelProviders: [...new Set([...previous.modelProviders, ...partial.modelProviders])],
    windows: [...merged.values()],
  };
}

function usageWindowIdentity(window: ProviderUsageSnapshotV1["windows"][number]): string {
  const scope =
    window.scope.kind === "model"
      ? `model:${[...window.scope.modelIds].sort().join(",")}`
      : window.scope.kind === "provider"
        ? `provider:${window.scope.id}`
        : window.scope.kind;
  return `${scope}:${window.id}`;
}

export const applyProviderUsageSnapshotToStatusline = applyProviderUsageSnapshot;

export function setStatuslineChecking(ctx: ExtensionContext): boolean {
  return setStatuslineValue(ctx, "checking");
}

export function clearStatuslineValue(ctx: ExtensionContext): boolean {
  return setStatuslineValue(ctx, undefined);
}
