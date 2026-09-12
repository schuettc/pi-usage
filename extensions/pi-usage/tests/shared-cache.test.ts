import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

const childFixture = fileURLToPath(new URL("./fixtures/shared-cache-child.ts", import.meta.url));
const packageDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function startCacheChild(
  mode: "hold-lock" | "write",
  cacheFile: string,
  provider?: "codex" | "anthropic",
): ChildProcess {
  return fork(childFixture, [mode, cacheFile, String(NOW), ...(provider ? [provider] : [])], {
    cwd: packageDirectory,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}

function waitForChildMessage(child: ChildProcess, type: "ready" | "done"): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timeout = setTimeout(() => finish(new Error(`child timed out waiting for ${type}`)), 10_000);
    const onMessage = (message: unknown) => {
      if (typeof message === "object" && message !== null && Reflect.get(message, "type") === type) finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`child exited before ${type}: code=${String(code)} signal=${String(signal)} ${stderr}`));
    };
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForChildExit(child);
  child.kill("SIGTERM");
  await exited;
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

void test("an aged companion lock held by a live child is not stolen and is recoverable after exit", async () => {
  await withCacheAsync(async (cacheFile) => {
    const child = startCacheChild("hold-lock", cacheFile);
    try {
      await waitForChildMessage(child, "ready");
      const staleTime = new Date(NOW - 60_000);
      utimesSync(`${cacheFile}.lock`, staleTime, staleTime);

      assert.equal(tryAcquireRefreshLease("codex", "parent", NOW), false);
      assert.equal(readSharedUsageCache(), undefined);

      await stopChild(child);
      assert.equal(tryAcquireRefreshLease("codex", "parent", NOW), true);
    } finally {
      await stopChild(child);
    }
  });
});

void test("concurrent child writers preserve both provider updates", async () => {
  await withCacheAsync(async (cacheFile) => {
    const codexChild = startCacheChild("write", cacheFile, "codex");
    const anthropicChild = startCacheChild("write", cacheFile, "anthropic");
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
