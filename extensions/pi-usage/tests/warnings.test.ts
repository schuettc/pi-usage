import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configureSharedCacheForTests, readSharedUsageCache } from "../src/shared-cache.js";
import { configureStatuslineForTests } from "../src/statusline.js";
import type { ProviderUsageEventV1, ProviderUsageSnapshotV1 } from "../src/types.js";
import {
  handleProviderUsageEvent,
  PROVIDER_USAGE_WARNING_ENTRY_TYPE,
  restoreProviderWarningState,
} from "../src/warnings.js";

const NOW = Date.parse("2026-09-12T13:00:00Z");
const codexModel = { provider: "openai-codex", id: "gpt-5", name: "GPT-5" };

type Notification = { message: string; level: string };
type Marker = { customType: string; data: unknown };
type WarningHarness = {
  ctx: ExtensionContext;
  markers: Marker[];
  notifications: Notification[];
  order: string[];
  pi: ExtensionAPI;
  statuses: Array<string | undefined>;
};

function snapshot(provider: "claude" | "codex", usedPercent: number): ProviderUsageSnapshotV1 {
  return {
    version: 1,
    provider,
    source: "test-event",
    capturedAt: NOW + usedPercent,
    complete: false,
    windows: [
      {
        id: `${provider}:five_hour`,
        label: "5h",
        usedPercent,
        scope: { kind: "account" },
      },
    ],
  };
}

function warning(
  provider: "claude" | "codex",
  message: string,
  attachedSnapshot?: ProviderUsageSnapshotV1,
): ProviderUsageEventV1 {
  return { version: 1, type: "soft-warning", provider, message, snapshot: attachedSnapshot };
}

function createHarness(entries: unknown[] = []): WarningHarness {
  const markers: Marker[] = [];
  const notifications: Notification[] = [];
  const order: string[] = [];
  const statuses: Array<string | undefined> = [];
  const pi = {
    appendEntry: (customType: string, data?: unknown) => {
      order.push("append");
      markers.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    model: codexModel,
    sessionManager: { getEntries: () => entries },
    ui: {
      notify: (message: string, level: string) => {
        order.push("notify");
        notifications.push({ message, level });
      },
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    },
  } as unknown as ExtensionContext;
  return { ctx, markers, notifications, order, pi, statuses };
}

async function withIsolatedUsageCache(run: () => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-warning-test-"));
  configureSharedCacheForTests({ cacheFile: join(directory, "usage-cache.json"), now: () => NOW });
  configureStatuslineForTests({
    now: () => NOW,
    setTimeout: () => ({ unref: () => {} }) as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: () => {},
  });
  try {
    await run();
  } finally {
    configureStatuslineForTests();
    configureSharedCacheForTests();
    rmSync(directory, { recursive: true, force: true });
  }
}

void test("shows the first soft warning at any utilization and persists its marker first", async () => {
  await withIsolatedUsageCache(() => {
    const harness = createHarness();
    restoreProviderWarningState(harness.pi, harness.ctx);

    handleProviderUsageEvent(harness.pi, harness.ctx, warning("codex", "Codex warning", snapshot("codex", 1)));

    assert.deepEqual(harness.notifications, [{ message: "Codex warning", level: "warning" }]);
    assert.deepEqual(harness.order, ["append", "notify"]);
    assert.equal(harness.markers.length, 1);
    const storedMarker = harness.markers[0];
    assert.ok(storedMarker);
    assert.equal(storedMarker.customType, PROVIDER_USAGE_WARNING_ENTRY_TYPE);
    assert.equal((storedMarker.data as { provider?: unknown }).provider, "codex");
    assert.equal(typeof (storedMarker.data as { shownAt?: unknown }).shownAt, "number");
    assert.equal(harness.statuses.at(-1), "Codex · 5h 1%");
  });
});

void test("suppresses later provider soft warnings while applying every attached snapshot", async () => {
  await withIsolatedUsageCache(() => {
    const harness = createHarness();
    restoreProviderWarningState(harness.pi, harness.ctx);

    handleProviderUsageEvent(harness.pi, harness.ctx, warning("codex", "first", snapshot("codex", 12)));
    handleProviderUsageEvent(harness.pi, harness.ctx, warning("codex", "second", snapshot("codex", 67)));

    assert.deepEqual(harness.notifications, [{ message: "first", level: "warning" }]);
    assert.equal(harness.markers.length, 1);
    assert.equal(harness.statuses.at(-1), "Codex · 5h 67%");
    const report = readSharedUsageCache()?.entries.codex?.report;
    assert.equal(report?.source, "external-adapter");
    if (report?.source !== "external-adapter") return;
    assert.equal(report.windows[0]?.usedPercent, 67);
  });
});

void test("tracks independent soft-warning allowances for Anthropic and Codex", async () => {
  await withIsolatedUsageCache(() => {
    const harness = createHarness();
    restoreProviderWarningState(harness.pi, harness.ctx);

    handleProviderUsageEvent(harness.pi, harness.ctx, warning("claude", "Anthropic warning"));
    handleProviderUsageEvent(harness.pi, harness.ctx, warning("codex", "Codex warning"));
    handleProviderUsageEvent(harness.pi, harness.ctx, warning("claude", "Anthropic repeat"));

    assert.deepEqual(
      harness.notifications.map(({ message }) => message),
      ["Anthropic warning", "Codex warning"],
    );
    assert.deepEqual(
      harness.markers.map(({ data }) => (data as { provider: string }).provider),
      ["claude", "codex"],
    );
  });
});

void test("restores durable markers and gives an unmarked session a fresh allowance", async () => {
  await withIsolatedUsageCache(() => {
    const harness = createHarness([
      {
        type: "custom",
        customType: PROVIDER_USAGE_WARNING_ENTRY_TYPE,
        data: { provider: "codex", shownAt: NOW - 1_000 },
      },
    ]);
    restoreProviderWarningState(harness.pi, harness.ctx);
    handleProviderUsageEvent(harness.pi, harness.ctx, warning("codex", "restored repeat"));
    assert.deepEqual(harness.notifications, []);

    const freshContext = createHarness();
    restoreProviderWarningState(harness.pi, freshContext.ctx);
    handleProviderUsageEvent(harness.pi, freshContext.ctx, warning("codex", "fresh session"));

    assert.deepEqual(freshContext.notifications, [{ message: "fresh session", level: "warning" }]);
    assert.equal(harness.markers.length, 1);
  });
});

void test("ignores warning markers without a recognized provider and finite numeric shownAt", async () => {
  await withIsolatedUsageCache(() => {
    const harness = createHarness([
      {
        type: "custom",
        customType: PROVIDER_USAGE_WARNING_ENTRY_TYPE,
        data: { provider: "codex" },
      },
      {
        type: "custom",
        customType: PROVIDER_USAGE_WARNING_ENTRY_TYPE,
        data: { provider: "codex", shownAt: "yesterday" },
      },
      {
        type: "custom",
        customType: PROVIDER_USAGE_WARNING_ENTRY_TYPE,
        data: { provider: "codex", shownAt: Number.NaN },
      },
      {
        type: "custom",
        customType: PROVIDER_USAGE_WARNING_ENTRY_TYPE,
        data: { provider: "codex", shownAt: Number.POSITIVE_INFINITY },
      },
      {
        type: "custom",
        customType: PROVIDER_USAGE_WARNING_ENTRY_TYPE,
        data: { provider: "other", shownAt: NOW },
      },
      {
        type: "custom",
        customType: PROVIDER_USAGE_WARNING_ENTRY_TYPE,
        data: { provider: "claude", shownAt: NOW },
      },
    ]);

    restoreProviderWarningState(harness.pi, harness.ctx);
    handleProviderUsageEvent(harness.pi, harness.ctx, warning("codex", "Codex warning"));
    handleProviderUsageEvent(harness.pi, harness.ctx, warning("claude", "Anthropic repeat"));

    assert.deepEqual(harness.notifications, [{ message: "Codex warning", level: "warning" }]);
    assert.equal(harness.markers.length, 1);
  });
});

void test("shows every hard limit without consuming the soft-warning allowance", async () => {
  await withIsolatedUsageCache(() => {
    const harness = createHarness();
    restoreProviderWarningState(harness.pi, harness.ctx);
    const hardLimit: ProviderUsageEventV1 = {
      version: 1,
      type: "hard-limit",
      provider: "codex",
      message: "Codex hard limit",
      snapshot: snapshot("codex", 100),
    };

    handleProviderUsageEvent(harness.pi, harness.ctx, hardLimit);
    handleProviderUsageEvent(harness.pi, harness.ctx, hardLimit);
    handleProviderUsageEvent(harness.pi, harness.ctx, warning("codex", "Codex soft warning"));

    assert.deepEqual(
      harness.notifications.map(({ message }) => message),
      ["Codex hard limit", "Codex hard limit", "Codex soft warning"],
    );
    assert.equal(harness.markers.length, 1);
    const storedMarker = harness.markers[0];
    assert.ok(storedMarker);
    assert.equal((storedMarker.data as { provider: string }).provider, "codex");
  });
});
