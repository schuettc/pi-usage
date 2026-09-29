import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CodexUsageReport } from "../src/types.js";

const NOW = Date.parse("2026-09-29T13:00:00Z");

// The native flock addon ships one prebuilt binary per Node major, so a new
// major (Node 26) cannot load it. The shared cache must then lock through
// node:sqlite instead of disabling itself, or every new session starts with
// no shared reading and shows "usage error" until its own first refresh.
void test("without the native addon, cache mutations lock through node:sqlite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-sqlite-backend-test-"));
  const cacheFile = join(directory, "usage-cache.json");
  const backendRuntime = await import("../src/mutation-lock-backend.js");
  backendRuntime.configureMutationLockRequireFactoryForTests((url) => {
    const real = createRequire(url);
    const onlyNativeMissing = ((id: string) => {
      if (id === "fs-ext-extra-prebuilt") throw new Error("No prebuilt binary found (simulated)");
      return real(id);
    }) as NodeJS.Require;
    return Object.assign(onlyNativeMissing, real);
  });
  try {
    const sharedCache = await import("../src/shared-cache.js");
    sharedCache.configureSharedCacheForTests({ cacheFile, now: () => NOW });

    assert.equal(sharedCache.isSharedCacheMutationAvailable(), true);

    const report: CodexUsageReport = {
      provider: "codex",
      source: "codex-app-server",
      capturedAt: NOW,
      snapshots: [{ limitId: "codex", primary: { usedPercent: 23, windowMinutes: 300 } }],
    };
    sharedCache.saveSharedUsageReport(report, NOW);
    assert.equal(sharedCache.readSharedUsageCache()?.entries.codex?.report.provider, "codex");

    assert.equal(sharedCache.tryAcquireRefreshLease("codex", "owner-a", NOW), true);
    assert.equal(sharedCache.tryAcquireRefreshLease("codex", "owner-b", NOW), false, "a held lease still excludes");
  } finally {
    backendRuntime.configureMutationLockRequireFactoryForTests();
    const sharedCache = await import("../src/shared-cache.js").catch(() => undefined);
    sharedCache?.configureSharedCacheForTests();
    rmSync(directory, { recursive: true, force: true });
  }
});
