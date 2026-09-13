import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CodexUsageReport, QueryUsageResult, SharedUsageCache } from "../src/types.js";

const NOW = Date.parse("2026-09-12T13:00:00Z");

type CommonJsLoader = {
  _load: (request: unknown, ...args: unknown[]) => unknown;
};

void test("a missing native lock backend cannot prevent the extension from loading", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-native-failure-test-"));
  const cacheFile = join(directory, "usage-cache.json");
  const moduleLoader = Module as unknown as CommonJsLoader;
  const originalLoad = moduleLoader._load;
  let backendLoadAttempts = 0;
  let providerQueryCalls = 0;

  moduleLoader._load = (request, ...args) => {
    if (request === "fs-ext-extra-prebuilt") {
      backendLoadAttempts += 1;
      throw new Error("simulated damaged native lock backend");
    }
    return Reflect.apply(originalLoad, moduleLoader, [request, ...args]);
  };

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
    assert.equal(backendLoadAttempts, 0, "import must not resolve the native mutation backend");
    assert.equal(providerQueryCalls, 0, "import must not query a usage provider");

    const original: SharedUsageCache = { version: 2, entries: {} };
    writeFileSync(cacheFile, JSON.stringify(original));
    sharedCache.configureSharedCacheForTests({ cacheFile, now: () => NOW });

    assert.deepEqual(sharedCache.readSharedUsageCache(), original);
    assert.equal(backendLoadAttempts, 0, "cache reads do not need the native mutation backend");

    const report: CodexUsageReport = {
      provider: "codex",
      source: "codex-app-server",
      capturedAt: NOW,
      snapshots: [{ limitId: "codex", primary: { usedPercent: 23, windowMinutes: 300 } }],
    };
    assert.doesNotThrow(() => sharedCache.saveSharedUsageReport(report, NOW));
    assert.deepEqual(JSON.parse(readFileSync(cacheFile, "utf8")), original, "mutation must fail closed");
    assert.equal(sharedCache.tryAcquireRefreshLease("codex", "test-owner", NOW), false);
    assert.doesNotThrow(() => sharedCache.releaseRefreshLease("codex", "test-owner"));
    assert.deepEqual(JSON.parse(readFileSync(cacheFile, "utf8")), original);
    assert.equal(backendLoadAttempts, 1, "an unavailable backend is resolved once and then stays disabled");
    assert.equal(providerQueryCalls, 0);
  } finally {
    moduleLoader._load = originalLoad;
    const sharedCache = await import("../src/shared-cache.js").catch(() => undefined);
    sharedCache?.configureSharedCacheForTests();
    const statusline = await import("../src/statusline.js").catch(() => undefined);
    statusline?.configureStatuslineForTests();
    rmSync(directory, { recursive: true, force: true });
  }
});
