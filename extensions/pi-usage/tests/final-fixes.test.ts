import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getUsageBusV1 } from "../src/adapter-bus.js";
import { throwUsageEndpointError } from "../src/errors.js";
import { formatUsageStatusline } from "../src/format.js";
import { queryAllUsage, queryUsage } from "../src/query.js";
import type { AdapterUsageReport, ProviderUsageSnapshotV1 } from "../src/types.js";
import { prettyJson } from "../src/utils.js";

const BUS_SYMBOL = Symbol.for("pi.provider-usage.bus.v1");
const registry = globalThis as typeof globalThis & Record<symbol, unknown>;
const capturedAt = Date.parse("2026-09-12T13:00:00Z");

function snapshot(overrides: Partial<ProviderUsageSnapshotV1> = {}): ProviderUsageSnapshotV1 {
  return {
    version: 1,
    provider: "claude",
    source: "claude-code-sdk",
    capturedAt,
    complete: true,
    adapterId: "schuettc.pi-claude-bridge",
    windows: [{ id: "five_hour", label: "5h", usedPercent: 25, scope: { kind: "account" } }],
    ...overrides,
  };
}

async function withCleanBus(run: () => void | Promise<void>): Promise<void> {
  const hadOriginal = Object.hasOwn(registry, BUS_SYMBOL);
  const original = registry[BUS_SYMBOL];
  delete registry[BUS_SYMBOL];
  try {
    await run();
  } finally {
    if (hadOriginal) registry[BUS_SYMBOL] = original;
    else delete registry[BUS_SYMBOL];
  }
}

void test("runtime bus rejects malformed adapters and events without invoking listeners", async () => {
  await withCleanBus(() => {
    const bus = getUsageBusV1();
    let calls = 0;
    bus.subscribe(() => calls++);

    const unregister = bus.register({
      id: "",
      usageProvider: "claude",
      modelProviders: ["claude-bridge"],
      refresh: async () => snapshot(),
    });
    unregister();
    for (const malformed of [
      { id: "bad-provider", usageProvider: "anthropic", modelProviders: ["bridge"], refresh: async () => snapshot() },
      { id: "bad-models", usageProvider: "claude", modelProviders: [1], refresh: async () => snapshot() },
      { id: "bad-refresh", usageProvider: "claude", modelProviders: ["bridge"], refresh: null },
    ])
      bus.register(malformed as never);
    assert.deepEqual(bus.adapters(), []);
    assert.equal(
      bus.publish({ version: 1, type: "snapshot", snapshot: { ...snapshot(), complete: "yes" } } as never),
      0,
    );
    assert.equal(bus.publish({ version: 1, type: "soft-warning", provider: "anthropic", message: "bad" } as never), 0);
    assert.equal(
      bus.publish({ version: 1, type: "soft-warning", provider: "claude", message: "", snapshot: snapshot() } as never),
      0,
    );
    assert.equal(
      bus.publish({ version: 1, type: "hard-limit", provider: "codex", message: "bad", snapshot: snapshot() }),
      0,
    );
    assert.equal(calls, 0);
  });
});

void test("incompatible or throwing optional registries fail open at model and query call sites", async () => {
  await withCleanBus(async () => {
    registry[BUS_SYMBOL] = { version: 2 };
    const ctx = {
      model: { provider: "bridge-only", id: "model", name: "Model" },
    } as unknown as ExtensionContext;
    await assert.doesNotReject(queryUsage(ctx, { timeoutMs: 10 }));

    registry[BUS_SYMBOL] = {
      version: 1,
      register() {
        return () => {};
      },
      adapters() {
        throw new Error("optional registry failed");
      },
      subscribe() {
        return () => {};
      },
      publish() {
        return 0;
      },
    };
    const result = await queryUsage(ctx, { timeoutMs: 10 });
    assert.equal(result.ok, false);
  });
});

void test("queryAllUsage includes each registered external adapter in bridge-only setups", async () => {
  await withCleanBus(async () => {
    const bus = getUsageBusV1();
    let calls = 0;
    bus.register({
      id: "schuettc.pi-claude-bridge",
      usageProvider: "claude",
      modelProviders: ["claude-bridge"],
      async refresh() {
        calls++;
        return snapshot();
      },
    });
    const ctx = {
      model: { provider: "claude-bridge", id: "claude-fable-5-1", name: "Fable" },
      modelRegistry: { getAvailable: () => [] },
    } as unknown as ExtensionContext;

    const result = await queryAllUsage(ctx, { timeoutMs: 100 });
    assert.equal(calls, 1);
    assert.equal(result.reports.length, 1);
    assert.equal(result.reports[0]?.provider, "claude");
  });
});

void test("selected display combines account, matching model and overage windows with every countdown", () => {
  const originalNow = Date.now;
  Date.now = () => capturedAt;
  const report: AdapterUsageReport = {
    provider: "claude",
    providerLabel: "Claude",
    source: "external-adapter",
    snapshotSource: "claude-code-sdk",
    adapterId: "schuettc.pi-claude-bridge",
    complete: true,
    modelProviders: ["claude-bridge"],
    capturedAt,
    windows: [
      {
        id: "five_hour",
        label: "5h",
        usedPercent: 75,
        resetsAt: (capturedAt + 2 * 3_600_000) / 1000,
        windowMinutes: 300,
        scope: { kind: "account" },
      },
      {
        id: "seven_day",
        label: "7d",
        usedPercent: 12,
        resetsAt: (capturedAt + 4 * 86_400_000) / 1000,
        windowMinutes: 10_080,
        scope: { kind: "account" },
      },
      {
        id: "model_scoped:fable",
        label: "7d",
        usedPercent: 42,
        resetsAt: (capturedAt + 3 * 86_400_000) / 1000,
        windowMinutes: 10_080,
        scope: { kind: "model", modelIds: ["claude-fable-5-1"], label: "Fable" },
      },
      { id: "extra_usage", label: "overage", usedPercent: 8, scope: { kind: "overage" } },
    ],
  };
  try {
    assert.equal(
      formatUsageStatusline(report, { provider: "claude-bridge", id: "claude-fable-5-1", name: "Fable" }),
      "Claude · 5h 75% ↻2h · Fable 42% ↻3d · overage 8%",
    );
  } finally {
    Date.now = originalNow;
  }
});

void test("normal endpoint errors omit response bodies and raw JSON recursively redacts identifiers", () => {
  const leaked = JSON.stringify({
    access_token: "access-secret",
    refresh_token: "refresh-secret",
    id_token: "id-secret",
    authorization: "Bearer auth-secret",
    organization_id: "org-secret",
    nested: { account_id: "acct-secret", arbitrary: "allowed in explicit raw" },
  });
  assert.throws(
    () => throwUsageEndpointError("Claude", new Response(leaked, { status: 429, statusText: "Limited" }), leaked),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /Claude.*429.*Limited/);
      for (const secret of [
        "access-secret",
        "refresh-secret",
        "id-secret",
        "auth-secret",
        "org-secret",
        "acct-secret",
        "arbitrary",
      ]) {
        assert.equal(message.includes(secret), false);
      }
      return true;
    },
  );
  const raw = prettyJson(leaked);
  for (const secret of ["access-secret", "refresh-secret", "id-secret", "auth-secret", "org-secret", "acct-secret"]) {
    assert.equal(raw.includes(secret), false);
  }
  assert.match(raw, /allowed in explicit raw/);
});
