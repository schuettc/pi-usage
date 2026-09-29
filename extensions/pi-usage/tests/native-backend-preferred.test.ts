import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const NOW = Date.parse("2026-09-29T13:00:00Z");

// Each backend-selection test is its own file: the resolved backend is cached
// per process, as it is in production.

// Where the native addon loads, it stays the lock: Node 20-25 keep flock, and
// node:sqlite (which warns on Node 22) is never opened.
void test("the native flock addon is preferred when it loads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-sqlite-backend-test-"));
  const cacheFile = join(directory, "usage-cache.json");
  let flockCalls = 0;
  let sqliteRequired = false;
  const backendRuntime = await import("../src/mutation-lock-backend.js");
  backendRuntime.configureMutationLockRequireFactoryForTests((url) => {
    const real = createRequire(url);
    const fakeNative = ((id: string) => {
      if (id === "fs-ext-extra-prebuilt")
        return {
          flockSync: () => {
            flockCalls += 1;
          },
        };
      if (id === "node:sqlite") sqliteRequired = true;
      return real(id);
    }) as NodeJS.Require;
    return Object.assign(fakeNative, real);
  });
  try {
    const sharedCache = await import("../src/shared-cache.js");
    sharedCache.configureSharedCacheForTests({ cacheFile, now: () => NOW });
    sharedCache.saveSharedUsageReport(
      { provider: "codex", source: "codex-app-server", capturedAt: NOW, snapshots: [{ limitId: "codex" }] },
      NOW,
    );
    assert.equal(sharedCache.readSharedUsageCache()?.entries.codex?.report.provider, "codex");
    assert.ok(flockCalls > 0, "the mutation locked through flock");
    assert.equal(sqliteRequired, false, "node:sqlite is not loaded when flock is available");
    assert.equal(existsSync(`${cacheFile}.lock.sqlite`), false);
  } finally {
    backendRuntime.configureMutationLockRequireFactoryForTests();
    const sharedCache = await import("../src/shared-cache.js").catch(() => undefined);
    sharedCache?.configureSharedCacheForTests();
    rmSync(directory, { recursive: true, force: true });
  }
});
