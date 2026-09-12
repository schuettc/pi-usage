import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CACHE_TTL_MS, REFRESH_LEASE_MS } from "../src/constants.js";
import {
  configureSharedCacheForTests,
  readFreshReportForModel,
  readSharedUsageCache,
  releaseRefreshLease,
  saveSharedUsageReport,
  tryAcquireRefreshLease,
} from "../src/shared-cache.js";
import type { AnthropicUsageReport, CodexUsageReport, SharedUsageCache } from "../src/types.js";
import {
  resumeMutationPhase,
  startCacheWriter,
  startPausedCacheWriter,
  stopChild,
  waitForChildExit,
  waitForChildMessage,
  waitForMutationPhase,
} from "./cache-process.js";

const NOW = Date.parse("2026-09-12T13:00:00Z");
const model = { provider: "openai-codex", id: "gpt-5", name: "GPT-5" };

function report(capturedAt = NOW, usedPercent = 23): CodexUsageReport {
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

function withCache(run: (cacheFile: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-cache-test-"));
  const cacheFile = join(directory, "usage-cache.json");
  configureSharedCacheForTests({ cacheFile, now: () => NOW });
  try {
    run(cacheFile);
  } finally {
    configureSharedCacheForTests();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function withCacheAsync(run: (cacheFile: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-cache-test-"));
  const cacheFile = join(directory, "usage-cache.json");
  configureSharedCacheForTests({ cacheFile, now: () => NOW });
  try {
    await run(cacheFile);
  } finally {
    configureSharedCacheForTests();
    rmSync(directory, { recursive: true, force: true });
  }
}

void test("malformed and version-1 cache files fail closed", () => {
  withCache((cacheFile) => {
    writeFileSync(cacheFile, "{not-json");
    assert.equal(readSharedUsageCache(), undefined);
    assert.equal(readFreshReportForModel(model, NOW), undefined);

    writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 2,
        entries: {
          codex: {
            createdAt: NOW,
            report: { provider: "codex", source: "codex-app-server", capturedAt: NOW, snapshots: [null] },
          },
        },
      }),
    );
    assert.equal(readSharedUsageCache(), undefined);

    writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 2,
        entries: {
          codex: {
            createdAt: NOW,
            report: {
              provider: "codex",
              source: "codex-app-server",
              capturedAt: NOW,
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
    assert.equal(readSharedUsageCache(), undefined);

    writeFileSync(cacheFile, JSON.stringify({ version: 1, entries: {} }));
    assert.equal(readSharedUsageCache(), undefined);
    assert.equal(readFreshReportForModel(model, NOW), undefined);
  });
});

void test("fresh model reports are read from schema v2 and stale reports are rejected", () => {
  withCache(() => {
    saveSharedUsageReport(report(NOW - 1_000), NOW - 1_000);

    assert.deepEqual(readFreshReportForModel(model, NOW), {
      createdAt: NOW - 1_000,
      report: report(NOW - 1_000),
    });
    assert.equal(readFreshReportForModel(model, NOW + CACHE_TTL_MS), undefined);
  });
});

void test("an expired refresh lease can be replaced with a clamped lease", () => {
  withCache(() => {
    assert.equal(tryAcquireRefreshLease("codex", "first", NOW), true);
    assert.deepEqual(readSharedUsageCache()?.refreshLeases?.codex, {
      owner: "first",
      expiresAt: NOW + REFRESH_LEASE_MS,
    });

    assert.equal(tryAcquireRefreshLease("codex", "second", NOW + REFRESH_LEASE_MS), true);
    assert.deepEqual(readSharedUsageCache()?.refreshLeases?.codex, {
      owner: "second",
      expiresAt: NOW + 2 * REFRESH_LEASE_MS,
    });
  });
});

void test("an unexpired lease suppresses every competing acquisition", () => {
  withCache(() => {
    assert.equal(tryAcquireRefreshLease("anthropic", "first", NOW), true);
    assert.equal(tryAcquireRefreshLease("anthropic", "foreign", NOW + 1), false);
    assert.equal(tryAcquireRefreshLease("anthropic", "first", NOW + 1), false);
    assert.deepEqual(readSharedUsageCache()?.refreshLeases?.anthropic, {
      owner: "first",
      expiresAt: NOW + REFRESH_LEASE_MS,
    });
  });
});

void test("only the matching owner can release a refresh lease", () => {
  withCache(() => {
    assert.equal(tryAcquireRefreshLease("codex", "owner", NOW), true);

    releaseRefreshLease("codex", "foreign");
    assert.equal(readSharedUsageCache()?.refreshLeases?.codex?.owner, "owner");

    releaseRefreshLease("codex", "owner");
    assert.equal(readSharedUsageCache()?.refreshLeases?.codex, undefined);
  });
});

void test("malformed legacy metadata and PID reuse cannot block the stable mutation lock", () => {
  withCache((cacheFile) => {
    const lockFile = `${cacheFile}.lock`;
    writeFileSync(lockFile, "{partial metadata");
    const originalInode = statSync(lockFile).ino;

    saveSharedUsageReport(report(), NOW);
    assert.equal(readSharedUsageCache()?.entries.codex?.report.provider, "codex");
    assert.equal(statSync(lockFile).ino, originalInode);

    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        token: "reused-pid",
        hostname: hostname(),
        acquiredAt: NOW,
      }),
    );
    saveSharedUsageReport(anthropicReport(), NOW);

    assert.equal(statSync(lockFile).ino, originalInode);
    assert.equal(readSharedUsageCache()?.entries.anthropic?.report.provider, "anthropic");
  });
});

void test("a pre-replacement holder fences a bounded contender and preserves both provider updates", async () => {
  await withCacheAsync(async (cacheFile) => {
    const controlFile = `${cacheFile}.control`;
    const codexChild = startPausedCacheWriter(cacheFile, NOW, "codex", "before-cache-replace", controlFile);
    try {
      await waitForMutationPhase(codexChild, controlFile, "before-cache-replace");

      const startedAt = performance.now();
      saveSharedUsageReport(anthropicReport(), NOW);
      const waitMs = performance.now() - startedAt;

      assert.ok(waitMs < 1_000, `lock contention was not bounded: ${waitMs}ms`);
      assert.equal(readSharedUsageCache(), undefined);

      const codexDone = waitForChildMessage(codexChild, "done");
      resumeMutationPhase(controlFile, "before-cache-replace");
      await codexDone;
      await waitForChildExit(codexChild);

      saveSharedUsageReport(anthropicReport(), NOW);
      const shared = readSharedUsageCache();
      assert.equal(shared?.entries.codex?.report.provider, "codex");
      assert.equal(shared?.entries.anthropic?.report.provider, "anthropic");
    } finally {
      await stopChild(codexChild);
    }
  });
});

void test("process death during acquisition automatically releases mutation ownership", async () => {
  await withCacheAsync(async (cacheFile) => {
    const controlFile = `${cacheFile}.control`;
    const child = startPausedCacheWriter(cacheFile, NOW, "codex", "after-acquire", controlFile);
    try {
      await waitForMutationPhase(child, controlFile, "after-acquire");
      await stopChild(child);

      saveSharedUsageReport(anthropicReport(), NOW);
      assert.equal(readSharedUsageCache()?.entries.anthropic?.report.provider, "anthropic");
    } finally {
      await stopChild(child);
    }
  });
});

void test("process death immediately before and after replacement cannot strand or corrupt the cache", async () => {
  for (const phase of ["before-cache-replace", "after-cache-replace"] as const) {
    await withCacheAsync(async (cacheFile) => {
      saveSharedUsageReport(report(), NOW);
      const controlFile = `${cacheFile}.control`;
      const child = startPausedCacheWriter(cacheFile, NOW, "anthropic", phase, controlFile);
      try {
        await waitForMutationPhase(child, controlFile, phase);

        saveSharedUsageReport(report(NOW + 1, 91), NOW + 1);
        const whileHeld = readSharedUsageCache();
        assert.equal(whileHeld?.entries.codex?.report.snapshots[0]?.primary?.usedPercent, 23);
        assert.equal(whileHeld?.entries.anthropic !== undefined, phase === "after-cache-replace");

        await stopChild(child);
        saveSharedUsageReport(report(NOW + 1, 91), NOW + 1);

        const recovered = readSharedUsageCache();
        assert.equal(recovered?.entries.codex?.report.snapshots[0]?.primary?.usedPercent, 91);
        assert.equal(recovered?.entries.anthropic !== undefined, phase === "after-cache-replace");
        assert.doesNotThrow(() => JSON.parse(readFileSync(cacheFile, "utf8")));
      } finally {
        await stopChild(child);
      }
    });
  }
});

void test("concurrent child writers preserve both provider updates", async () => {
  await withCacheAsync(async (cacheFile) => {
    const codexChild = startCacheWriter(cacheFile, NOW, "codex");
    const anthropicChild = startCacheWriter(cacheFile, NOW, "anthropic");
    try {
      await Promise.all([waitForChildMessage(codexChild, "ready"), waitForChildMessage(anthropicChild, "ready")]);
      const codexDone = waitForChildMessage(codexChild, "done");
      const anthropicDone = waitForChildMessage(anthropicChild, "done");
      codexChild.send("write");
      anthropicChild.send("write");
      await Promise.all([codexDone, anthropicDone]);
      await Promise.all([waitForChildExit(codexChild), waitForChildExit(anthropicChild)]);

      const shared = readSharedUsageCache();
      assert.equal(shared?.entries.codex?.report.provider, "codex");
      assert.equal(shared?.entries.anthropic?.report.provider, "anthropic");
    } finally {
      await Promise.all([stopChild(codexChild), stopChild(anthropicChild)]);
    }
  });
});

void test("a simulated rename failure preserves valid cache JSON", () => {
  withCache((cacheFile) => {
    const original: SharedUsageCache = { version: 2, entries: {} };
    writeFileSync(cacheFile, JSON.stringify(original));
    configureSharedCacheForTests({
      cacheFile,
      now: () => NOW,
      rename: () => {
        throw new Error("simulated rename failure");
      },
    });

    assert.doesNotThrow(() => saveSharedUsageReport(report(), NOW));
    assert.deepEqual(JSON.parse(readFileSync(cacheFile, "utf8")), original);
    assert.deepEqual(readSharedUsageCache(), original);
  });
});
