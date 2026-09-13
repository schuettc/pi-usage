import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CodexUsageReport, QueryUsageResult, SharedUsageCache } from "../src/types.js";

const NOW = Date.parse("2026-09-12T13:00:00Z");

void test("a require setup failure is lazy, contained, and cached", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-native-failure-test-"));
  const cacheFile = join(directory, "usage-cache.json");
  let requireFactoryAttempts = 0;
  let providerQueryCalls = 0;
  const backendRuntime = await import("../src/mutation-lock-backend.js");
  backendRuntime.configureMutationLockRequireFactoryForTests(() => {
    requireFactoryAttempts += 1;
    throw new Error("simulated require factory setup failure");
  });

  try {
    const sharedCache = await import("../src/shared-cache.js");
    const statusline = await import("../src/statusline.js");
    statusline.configureStatuslineForTests({
      queryUsage: async (): Promise<QueryUsageResult> => {
        providerQueryCalls += 1;
        return { ok: false, errors: [{ source: "test", message: "must not run during import" }] };
      },
    });
    const extension = await import("../src/index.js");

    assert.equal(typeof extension.default, "function");
    assert.equal(requireFactoryAttempts, 0, "imports must not set up the native mutation backend");
    assert.equal(providerQueryCalls, 0, "import must not query a usage provider");

    const original: SharedUsageCache = { version: 2, entries: {} };
    writeFileSync(cacheFile, JSON.stringify(original));
    sharedCache.configureSharedCacheForTests({ cacheFile, now: () => NOW });

    assert.deepEqual(sharedCache.readSharedUsageCache(), original);
    assert.equal(requireFactoryAttempts, 0, "cache reads do not need the native mutation backend");

    const report: CodexUsageReport = {
      provider: "codex",
      source: "codex-app-server",
      capturedAt: NOW,
      snapshots: [{ limitId: "codex", primary: { usedPercent: 23, windowMinutes: 300 } }],
    };
    assert.doesNotThrow(() => sharedCache.saveSharedUsageReport(report, NOW));
    assert.equal(requireFactoryAttempts, 1, "the first mutation contains require setup failure");
    assert.deepEqual(JSON.parse(readFileSync(cacheFile, "utf8")), original, "mutation must fail closed");
    assert.deepEqual(sharedCache.readSharedUsageCache(), original, "reads remain available after setup failure");

    assert.equal(sharedCache.tryAcquireRefreshLease("codex", "test-owner", NOW), false);
    assert.doesNotThrow(() => sharedCache.releaseRefreshLease("codex", "test-owner"));
    assert.deepEqual(JSON.parse(readFileSync(cacheFile, "utf8")), original);
    assert.equal(requireFactoryAttempts, 1, "a failed require setup is cached and never retried");

    const statuses: Array<string | undefined> = [];
    statusline.setSessionActive(true);
    await statusline.refreshCurrentUsageStatusline({
      model: { provider: "openai-codex", id: "gpt-5", name: "GPT-5" },
      ui: { setStatus: (_key: string, value: string | undefined) => statuses.push(value) },
    } as never);
    assert.equal(providerQueryCalls, 1, "missing flock falls back to an uncoordinated provider refresh");
    assert.deepEqual(statuses, ["checking", "usage error"]);
  } finally {
    backendRuntime.configureMutationLockRequireFactoryForTests();
    const sharedCache = await import("../src/shared-cache.js").catch(() => undefined);
    sharedCache?.configureSharedCacheForTests();
    const statusline = await import("../src/statusline.js").catch(() => undefined);
    statusline?.configureStatuslineForTests();
    rmSync(directory, { recursive: true, force: true });
  }
});
