import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import type { CodexUsageReport, SharedUsageCache } from "../src/types.js";

const NOW = Date.parse("2026-09-12T13:00:00Z");
const model = { provider: "openai-codex", id: "gpt-5", name: "GPT-5" };

function report(capturedAt = NOW): CodexUsageReport {
  return {
    provider: "codex",
    source: "codex-app-server",
    capturedAt,
    snapshots: [
      {
        limitId: "codex",
        primary: { usedPercent: 23, windowMinutes: 300 },
      },
    ],
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

void test("the companion mutation lock blocks acquisition and recovers when stale", () => {
  withCache((cacheFile) => {
    const lockFile = `${cacheFile}.lock`;
    writeFileSync(lockFile, JSON.stringify({ owner: "other", acquiredAt: NOW }));

    assert.equal(tryAcquireRefreshLease("codex", "owner", NOW), false);
    assert.equal(readSharedUsageCache(), undefined);

    const staleTime = new Date(NOW - 60_000);
    utimesSync(lockFile, staleTime, staleTime);
    assert.equal(tryAcquireRefreshLease("codex", "owner", NOW), true);
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
