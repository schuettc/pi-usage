import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getUsageBusV1 } from "../src/adapter-bus.js";
import { CACHE_TTL_MS, REFRESH_LEASE_MS } from "../src/constants.js";
import {
  configureSharedCacheForTests,
  readSharedUsageCache,
  saveSharedBackoff,
  saveSharedUsageReport,
  tryAcquireRefreshLease,
} from "../src/shared-cache.js";
import {
  applyProviderUsageSnapshot,
  configureStatuslineForTests,
  refreshCurrentUsageStatusline,
  setSessionActive,
} from "../src/statusline.js";
import type {
  AnthropicUsageReport,
  CodexUsageReport,
  ProviderUsageSnapshotV1,
  QueryUsageResult,
} from "../src/types.js";
import { startPausedCacheWriter, stopChild, waitForMutationPhase } from "./cache-process.js";

const NOW = Date.parse("2026-09-12T13:00:00Z");
const codexModel = { provider: "openai-codex", id: "gpt-5", name: "GPT-5" };
const anthropicModel = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" };

type FakeTimer = {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
  unref: () => void;
};

type Harness = {
  cacheFile: string;
  timers: FakeTimer[];
  setNow: (now: number) => void;
  setQuery: (query: (ctx: ExtensionContext) => Promise<QueryUsageResult>) => void;
};

function codexReport(capturedAt = NOW, usedPercent = 23): CodexUsageReport {
  return {
    provider: "codex",
    source: "codex-app-server",
    capturedAt,
    snapshots: [
      {
        limitId: "codex",
        primary: { usedPercent, windowMinutes: 300 },
      },
    ],
  };
}

function anthropicReport(capturedAt = NOW): AnthropicUsageReport {
  return {
    provider: "anthropic",
    source: "anthropic-oauth",
    capturedAt,
    windows: [],
    summaryLines: ["Anthropic usage"],
    statusline: "Claude usage",
  };
}

function context(
  model: { provider: string; id: string; name: string },
  statuses: Array<string | undefined>,
): ExtensionContext {
  return {
    model,
    ui: {
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    },
  } as unknown as ExtensionContext;
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-statusline-test-"));
  const cacheFile = join(directory, "usage-cache.json");
  const timers: FakeTimer[] = [];
  let now = NOW;
  let query = async (): Promise<QueryUsageResult> => ({ ok: true, report: codexReport() });

  configureSharedCacheForTests({ cacheFile, now: () => now });
  configureStatuslineForTests({
    now: () => now,
    queryUsage: (ctx) => query(ctx),
    setTimeout: (callback, delayMs) => {
      const timer: FakeTimer = { callback, delayMs, cleared: false, unref: () => {} };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => {
      (timer as unknown as FakeTimer).cleared = true;
    },
  });
  setSessionActive(true);

  try {
    await run({
      cacheFile,
      timers,
      setNow: (nextNow) => {
        now = nextNow;
      },
      setQuery: (nextQuery) => {
        query = nextQuery;
      },
    });
  } finally {
    configureStatuslineForTests();
    configureSharedCacheForTests();
    rmSync(directory, { recursive: true, force: true });
  }
}

void test("fresh disk cache renders synchronously without starting a provider query", async () => {
  await withHarness(async ({ timers, setQuery }) => {
    let queryCalls = 0;
    setQuery(async () => {
      queryCalls += 1;
      return { ok: true, report: codexReport() };
    });
    saveSharedUsageReport(codexReport(NOW - 1_000), NOW - 1_000);
    const statuses: Array<string | undefined> = [];
    const ctx = context(codexModel, statuses);

    const refresh = refreshCurrentUsageStatusline(ctx, codexModel);

    assert.equal(queryCalls, 0);
    assert.equal(statuses.at(-1), "codex 23% 5h");
    assert.equal(timers.at(-1)?.delayMs, CACHE_TTL_MS - 1_000);
    await refresh;
  });
});

void test("malformed cached credits fail closed without crashing statusline rendering", async () => {
  await withHarness(async ({ cacheFile, setQuery }) => {
    let queryCalls = 0;
    setQuery(async () => {
      queryCalls += 1;
      return { ok: false, errors: [{ source: "codex-app-server", message: "offline" }] };
    });
    writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 2,
        entries: {
          codex: {
            createdAt: NOW - 1_000,
            report: {
              provider: "codex",
              source: "codex-app-server",
              capturedAt: NOW - 1_000,
              snapshots: [
                {
                  limitId: "codex",
                  credits: { hasCredits: true, unlimited: false, balance: { amount: "12.34" } },
                },
              ],
            },
          },
        },
      }),
    );
    const statuses: Array<string | undefined> = [];

    await assert.doesNotReject(refreshCurrentUsageStatusline(context(codexModel, statuses), codexModel));

    assert.equal(queryCalls, 1);
    assert.deepEqual(statuses, ["checking", "usage error"]);
  });
});

void test("stale cache stays visible with an age marker while refresh is pending", async () => {
  await withHarness(async ({ setQuery }) => {
    let resolveQuery!: (result: QueryUsageResult) => void;
    let queryCalls = 0;
    setQuery(
      () =>
        new Promise((resolve) => {
          queryCalls += 1;
          resolveQuery = resolve;
        }),
    );
    const staleAt = NOW - CACHE_TTL_MS - 60_000;
    saveSharedUsageReport(codexReport(staleAt), staleAt);
    const statuses: Array<string | undefined> = [];
    const ctx = context(codexModel, statuses);

    const refresh = refreshCurrentUsageStatusline(ctx, codexModel);

    assert.equal(queryCalls, 1);
    assert.equal(statuses.at(-1), "codex 23% 5h (4m old)");
    assert.match(readSharedUsageCache()?.refreshLeases?.codex?.owner ?? "", /^\d+:[0-9a-f-]+$/i);

    resolveQuery({ ok: true, report: codexReport(NOW, 31) });
    await refresh;
    assert.equal(statuses.at(-1), "codex 31% 5h");
    assert.equal(readSharedUsageCache()?.refreshLeases?.codex, undefined);
  });
});

void test("a foreign lease suppresses duplicate refresh and retries at lease expiry", async () => {
  await withHarness(async ({ timers, setQuery }) => {
    let queryCalls = 0;
    setQuery(async () => {
      queryCalls += 1;
      return { ok: true, report: codexReport() };
    });
    const staleAt = NOW - CACHE_TTL_MS - 60_000;
    saveSharedUsageReport(codexReport(staleAt), staleAt);
    assert.equal(tryAcquireRefreshLease("codex", "foreign", NOW - 5_000), true);
    const statuses: Array<string | undefined> = [];

    await refreshCurrentUsageStatusline(context(codexModel, statuses), codexModel);

    assert.equal(queryCalls, 0);
    assert.equal(statuses.at(-1), "codex 23% 5h (4m old)");
    assert.equal(timers.at(-1)?.delayMs, REFRESH_LEASE_MS - 5_000);
  });
});

void test("mutation-lock contention fails bounded without starting provider network work", async () => {
  await withHarness(async ({ cacheFile, timers, setQuery }) => {
    const controlFile = `${cacheFile}.control`;
    const child = startPausedCacheWriter(cacheFile, NOW, "anthropic", "after-acquire", controlFile);
    let queryCalls = 0;
    setQuery(async () => {
      queryCalls += 1;
      return { ok: true, report: codexReport() };
    });

    try {
      await waitForMutationPhase(child, controlFile, "after-acquire");
      const statuses: Array<string | undefined> = [];
      const startedAt = performance.now();

      await refreshCurrentUsageStatusline(context(codexModel, statuses), codexModel);

      const waitMs = performance.now() - startedAt;
      assert.ok(waitMs < 1_000, `lock contention was not bounded: ${waitMs}ms`);
      assert.equal(queryCalls, 0);
      assert.equal(statuses.at(-1), "checking");
      assert.equal(timers.at(-1)?.delayMs, REFRESH_LEASE_MS);
    } finally {
      await stopChild(child);
    }
  });
});

void test("parallel refresh attempts make only one provider call", async () => {
  await withHarness(async ({ timers, setQuery }) => {
    let resolveQuery!: (result: QueryUsageResult) => void;
    let queryCalls = 0;
    setQuery(
      () =>
        new Promise((resolve) => {
          queryCalls += 1;
          resolveQuery = resolve;
        }),
    );
    const firstStatuses: Array<string | undefined> = [];
    const secondStatuses: Array<string | undefined> = [];

    const first = refreshCurrentUsageStatusline(context(codexModel, firstStatuses), codexModel);
    const second = refreshCurrentUsageStatusline(context(codexModel, secondStatuses), codexModel);

    assert.equal(queryCalls, 1);
    assert.equal(secondStatuses.at(-1), "checking");
    assert.equal(timers.at(-1)?.delayMs, REFRESH_LEASE_MS);

    resolveQuery({ ok: true, report: codexReport() });
    await Promise.all([first, second]);
  });
});

void test("an expired lease is not reacquired in-process while its earlier provider poll is live", async () => {
  await withHarness(async ({ setNow, setQuery }) => {
    let firstResolve!: (result: QueryUsageResult) => void;
    let secondResolve: ((result: QueryUsageResult) => void) | undefined;
    let queryCalls = 0;
    setQuery(
      () =>
        new Promise((resolve) => {
          queryCalls += 1;
          if (queryCalls === 1) firstResolve = resolve;
          else secondResolve = resolve;
        }),
    );
    saveSharedUsageReport(anthropicReport(), NOW);
    const statuses: Array<string | undefined> = [];
    const ctx = context(codexModel, statuses);
    const firstRefresh = refreshCurrentUsageStatusline(ctx, codexModel);
    let blockedRefresh: Promise<void> | undefined;

    try {
      assert.equal(queryCalls, 1);

      (ctx as unknown as { model: typeof anthropicModel }).model = anthropicModel;
      await refreshCurrentUsageStatusline(ctx, anthropicModel);
      setNow(NOW + REFRESH_LEASE_MS);
      (ctx as unknown as { model: typeof codexModel }).model = codexModel;

      blockedRefresh = refreshCurrentUsageStatusline(ctx, codexModel);

      assert.equal(queryCalls, 1);
      assert.equal(readSharedUsageCache()?.refreshLeases?.codex?.expiresAt, NOW + REFRESH_LEASE_MS);

      firstResolve({ ok: false, errors: [{ source: "codex-app-server", message: "offline" }] });
      await Promise.all([firstRefresh, blockedRefresh]);

      const nextRefresh = refreshCurrentUsageStatusline(ctx, codexModel);
      assert.equal(queryCalls, 2);
      secondResolve?.({ ok: true, report: codexReport(NOW + REFRESH_LEASE_MS, 41) });
      await nextRefresh;
    } finally {
      const failure: QueryUsageResult = {
        ok: false,
        errors: [{ source: "codex-app-server", message: "test cleanup" }],
      };
      firstResolve(failure);
      secondResolve?.(failure);
      await Promise.allSettled([firstRefresh, ...(blockedRefresh ? [blockedRefresh] : [])]);
    }
  });
});

void test("an external Anthropic adapter coordinates with Anthropic lease and backoff state", async () => {
  await withHarness(async ({ setQuery }) => {
    const model = { provider: "claude-bridge", id: "claude-sonnet", name: "Claude Sonnet" };
    const snapshot: ProviderUsageSnapshotV1 = {
      version: 1,
      provider: "anthropic",
      capturedAt: NOW,
      windows: [{ id: "five_hour", label: "5h", usedPercent: 36, scope: { kind: "account" } }],
    };
    const unregister = getUsageBusV1().register({
      id: "anthropic-coordination",
      usageProvider: "anthropic",
      modelProviders: [model.provider],
      refresh: async () => snapshot,
    });
    let resolveQuery!: (result: QueryUsageResult) => void;
    let queryCalls = 0;
    setQuery(
      () =>
        new Promise((resolve) => {
          queryCalls += 1;
          resolveQuery = resolve;
        }),
    );
    saveSharedBackoff("codex", NOW + REFRESH_LEASE_MS, NOW);
    saveSharedBackoff("anthropic", NOW - 1, NOW);

    try {
      const refresh = refreshCurrentUsageStatusline(context(model, []), model);

      assert.equal(queryCalls, 1);
      assert.equal(readSharedUsageCache()?.refreshLeases?.codex, undefined);
      assert.match(readSharedUsageCache()?.refreshLeases?.anthropic?.owner ?? "", /^\d+:[0-9a-f-]+$/i);

      resolveQuery({
        ok: true,
        report: {
          provider: "anthropic",
          source: "external-adapter",
          modelProviders: [model.provider],
          capturedAt: NOW,
          windows: snapshot.windows,
        },
      });
      await refresh;

      assert.equal(readSharedUsageCache()?.backoffUntil?.codex, NOW + REFRESH_LEASE_MS);
      assert.equal(readSharedUsageCache()?.backoffUntil?.anthropic, undefined);
      assert.equal(readSharedUsageCache()?.refreshLeases?.anthropic, undefined);
    } finally {
      unregister();
    }
  });
});

void test("changing providers cancels the prior timer and clears selected-provider text", async () => {
  await withHarness(async ({ timers, setQuery }) => {
    saveSharedUsageReport(codexReport(NOW - 1_000), NOW - 1_000);
    const statuses: Array<string | undefined> = [];
    const ctx = context(codexModel, statuses);
    await refreshCurrentUsageStatusline(ctx, codexModel);
    const codexTimer = timers.at(-1);
    assert.ok(codexTimer);

    setQuery(async () => ({
      ok: false,
      errors: [{ source: "anthropic-oauth", message: "offline" }],
    }));
    (ctx as unknown as { model: typeof anthropicModel }).model = anthropicModel;
    await refreshCurrentUsageStatusline(ctx, anthropicModel);

    assert.equal(codexTimer.cleared, true);
    assert.deepEqual(statuses.slice(-3), [undefined, "checking", "usage error"]);
    assert.equal(statuses.includes("codex 23% 5h (4m old)"), false);
  });
});

void test("a non-selected adapter snapshot updates cache without clearing the selected footer", async () => {
  await withHarness(async () => {
    saveSharedUsageReport(codexReport(NOW - 1_000), NOW - 1_000);
    const statuses: Array<string | undefined> = [];
    const ctx = context(codexModel, statuses);
    await refreshCurrentUsageStatusline(ctx, codexModel);

    assert.equal(
      applyProviderUsageSnapshot(ctx, {
        version: 1,
        provider: "anthropic",
        capturedAt: NOW,
        windows: [
          {
            id: "five_hour",
            label: "5h",
            usedPercent: 52,
            scope: { kind: "account" },
          },
        ],
      }),
      false,
    );

    assert.equal(statuses.at(-1), "codex 23% 5h");
    assert.equal(readSharedUsageCache()?.entries.anthropic?.report.provider, "anthropic");
  });
});

void test("a mismatched Codex snapshot does not update a selected custom Anthropic footer", async () => {
  await withHarness(async () => {
    const anthropicSnapshot: ProviderUsageSnapshotV1 = {
      version: 1,
      provider: "anthropic",
      capturedAt: NOW,
      windows: [{ id: "five_hour", label: "5h", usedPercent: 64, scope: { kind: "account" } }],
    };
    const unregister = getUsageBusV1().register({
      id: "claude-mismatch",
      usageProvider: "anthropic",
      modelProviders: ["claude-bridge"],
      refresh: async () => anthropicSnapshot,
    });
    const statuses: Array<string | undefined> = [];
    const ctx = context({ provider: "claude-bridge", id: "claude-sonnet", name: "Claude Sonnet" }, statuses);

    try {
      assert.equal(applyProviderUsageSnapshot(ctx, anthropicSnapshot), true);
      assert.equal(statuses.at(-1), "Claude · 5h 64%");

      assert.equal(
        applyProviderUsageSnapshot(ctx, {
          version: 1,
          provider: "codex",
          capturedAt: NOW + 1,
          windows: [{ id: "five_hour", label: "5h", usedPercent: 82, scope: { kind: "account" } }],
        }),
        false,
      );

      assert.equal(statuses.at(-1), "Claude · 5h 64%");
      assert.deepEqual(readSharedUsageCache()?.entries.codex?.report, {
        provider: "codex",
        source: "external-adapter",
        modelProviders: ["openai-codex"],
        capturedAt: NOW + 1,
        windows: [{ id: "five_hour", label: "5h", usedPercent: 82, scope: { kind: "account" } }],
      });
    } finally {
      unregister();
    }
  });
});

void test("adapter snapshot application updates shared cache and the selected footer immediately", async () => {
  await withHarness(async () => {
    const unregister = getUsageBusV1().register({
      id: "claude-bridge",
      usageProvider: "anthropic",
      modelProviders: ["claude-bridge"],
      refresh: async () => snapshot,
    });
    const snapshot: ProviderUsageSnapshotV1 = {
      version: 1,
      provider: "anthropic",
      capturedAt: NOW,
      windows: [
        {
          id: "five_hour",
          label: "5h",
          usedPercent: 64,
          scope: { kind: "account" },
        },
      ],
    };
    const statuses: Array<string | undefined> = [];
    const ctx = context({ provider: "claude-bridge", id: "claude-sonnet", name: "Claude Sonnet" }, statuses);

    try {
      assert.equal(applyProviderUsageSnapshot(ctx, snapshot), true);
      assert.equal(statuses.at(-1), "Claude · 5h 64%");
      assert.deepEqual(readSharedUsageCache()?.entries.anthropic, {
        createdAt: NOW,
        report: {
          provider: "anthropic",
          source: "external-adapter",
          modelProviders: ["claude-bridge", "anthropic"],
          capturedAt: NOW,
          windows: snapshot.windows,
        },
      });
    } finally {
      unregister();
    }
  });
});
