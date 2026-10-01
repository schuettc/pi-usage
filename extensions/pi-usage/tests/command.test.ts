import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getUsageBusV1 } from "../src/adapter-bus.js";
import { registerUsageCommand } from "../src/command.js";
import { configureSharedCacheForTests, saveSharedUsageReport } from "../src/shared-cache.js";
import { configureStatuslineForTests, setCombinedCache, setSessionActive } from "../src/statusline.js";
import type { AdapterUsageReport, ProviderUsageSnapshotV1 } from "../src/types.js";

const NOW = Date.parse("2026-09-30T13:00:00Z");
const model = { provider: "claude-bridge", id: "claude-sonnet", name: "Claude Sonnet" };

function adapterReport(accountId: string, usedPercent: number): AdapterUsageReport {
  return {
    provider: "claude",
    source: "external-adapter",
    snapshotSource: "test-adapter",
    adapterId: "bridge",
    complete: true,
    modelProviders: ["claude-bridge"],
    account: { id: accountId },
    capturedAt: NOW,
    windows: [{ id: "five_hour", label: "5h", usedPercent, scope: { kind: "account" } }],
  };
}

function snapshotFor(accountId: string, usedPercent: number): ProviderUsageSnapshotV1 {
  return {
    version: 1,
    provider: "claude",
    source: "test-adapter",
    adapterId: "bridge",
    capturedAt: NOW,
    complete: true,
    account: { id: accountId },
    windows: [{ id: "five_hour", label: "5h", usedPercent, scope: { kind: "account" } }],
  };
}

function fakeContext(notifications: string[], statuses: Array<string | undefined>): ExtensionCommandContext {
  return {
    model,
    hasUI: false,
    modelRegistry: { getAvailable: () => [] },
    ui: {
      notify: (text: string) => notifications.push(text),
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    },
  } as unknown as ExtensionCommandContext;
}

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

/** The command's query path is fire-and-forget; let its microtasks and one
 * macrotask hop settle before asserting on its side effects. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function registerHandler(): Handler {
  let handler: Handler | undefined;
  registerUsageCommand({
    registerCommand: (_name, definition) => {
      handler = definition.handler as Handler;
    },
  } as never);
  if (!handler) throw new Error("handler was not registered");
  return handler;
}

async function withHarness(run: (handler: Handler) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-command-test-"));
  const cacheFile = join(directory, "usage-cache.json");
  configureSharedCacheForTests({ cacheFile, now: () => NOW });
  configureStatuslineForTests({ now: () => NOW });
  setSessionActive(true);
  try {
    await run(registerHandler());
  } finally {
    configureStatuslineForTests();
    configureSharedCacheForTests();
    rmSync(directory, { recursive: true, force: true });
  }
}

void test("/usage never shows account A's cached report (in memory) once the adapter reports account B, and queries B instead", async () => {
  await withHarness(async (handler) => {
    let refreshedAccountId: string | undefined;
    const unregister = getUsageBusV1().register({
      id: "bridge",
      usageProvider: "claude",
      modelProviders: ["claude-bridge"],
      currentAccount: () => ({ id: "B" }),
      refresh: async () => {
        refreshedAccountId = "B";
        return snapshotFor("B", 46);
      },
    });
    try {
      setCombinedCache({ createdAt: NOW, reports: [adapterReport("A", 11)] });
      const notifications: string[] = [];
      const statuses: Array<string | undefined> = [];
      const ctx = fakeContext(notifications, statuses);

      await handler("", ctx);
      await flush();

      assert.equal(refreshedAccountId, "B", "the cache-miss fallback must query the current account");
      assert.equal(
        notifications.some((text) => text.includes("11%")),
        false,
        "account A's cached usage must never be printed",
      );
      assert.equal(
        statuses.some((status) => status?.includes("11%")),
        false,
        "account A's cached usage must never be applied to the statusline",
      );
      assert.equal(
        notifications.some((text) => text.includes("46%")),
        true,
        "account B's freshly queried usage must be shown",
      );
    } finally {
      unregister();
    }
  });
});

void test("/usage never shows account A's cached report (on disk) once the adapter reports account B, and queries B instead", async () => {
  await withHarness(async (handler) => {
    saveSharedUsageReport(adapterReport("A", 11), NOW);
    let refreshedAccountId: string | undefined;
    const unregister = getUsageBusV1().register({
      id: "bridge",
      usageProvider: "claude",
      modelProviders: ["claude-bridge"],
      currentAccount: () => ({ id: "B" }),
      refresh: async () => {
        refreshedAccountId = "B";
        return snapshotFor("B", 46);
      },
    });
    try {
      const notifications: string[] = [];
      const statuses: Array<string | undefined> = [];
      const ctx = fakeContext(notifications, statuses);

      await handler("", ctx);
      await flush();

      assert.equal(refreshedAccountId, "B", "the cache-miss fallback must query the current account");
      assert.equal(
        notifications.some((text) => text.includes("11%")),
        false,
        "account A's cached usage must never be printed",
      );
      assert.equal(
        notifications.some((text) => text.includes("46%")),
        true,
        "account B's freshly queried usage must be shown",
      );
    } finally {
      unregister();
    }
  });
});

void test("/usage's stale-usage-retained fallback never shows account A's report after a failed refresh for account B", async () => {
  await withHarness(async (handler) => {
    const unregister = getUsageBusV1().register({
      id: "bridge",
      usageProvider: "claude",
      modelProviders: ["claude-bridge"],
      currentAccount: () => ({ id: "B" }),
      refresh: async () => {
        throw new Error("account B refresh failed");
      },
    });
    try {
      setCombinedCache({ createdAt: NOW, reports: [adapterReport("A", 11)] });
      const notifications: string[] = [];
      const statuses: Array<string | undefined> = [];
      const ctx = fakeContext(notifications, statuses);

      await handler("", ctx);
      await flush();

      assert.equal(
        notifications.some((text) => text.includes("11%")),
        false,
        "a failed refresh for B must never fall back to showing A's stale report",
      );
      assert.equal(
        statuses.some((status) => status?.includes("11%")),
        false,
        "a failed refresh for B must never apply A's stale report to the statusline",
      );
    } finally {
      unregister();
    }
  });
});
