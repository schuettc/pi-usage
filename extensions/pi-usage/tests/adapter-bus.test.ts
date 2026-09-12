import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getUsageBusV1 } from "../src/adapter-bus.js";
import { isUsageSupportedModel } from "../src/models.js";
import { queryUsage } from "../src/query.js";
import type {
  ProviderUsageAdapterV1,
  ProviderUsageBusV1,
  ProviderUsageEventV1,
  ProviderUsageSnapshotV1,
} from "../src/types.js";

const BUS_SYMBOL = Symbol.for("pi.provider-usage.bus.v1");
const globalRegistry = globalThis as typeof globalThis & Record<symbol, unknown>;

function usageSnapshot(usedPercent = 32): ProviderUsageSnapshotV1 {
  return {
    version: 1,
    provider: "codex",
    capturedAt: Date.parse("2026-09-12T13:00:00Z"),
    windows: [
      {
        id: "gpt:five_hour",
        label: "5h",
        usedPercent,
        scope: { kind: "account" },
      },
    ],
  };
}

function adapter(
  id: string,
  modelProviders: string[] = ["bridge-provider"],
  refresh: ProviderUsageAdapterV1["refresh"] = async () => usageSnapshot(),
): ProviderUsageAdapterV1 {
  return { id, modelProviders, refresh };
}

async function withCleanBus(run: () => void | Promise<void>): Promise<void> {
  const hadOriginal = Object.hasOwn(globalRegistry, BUS_SYMBOL);
  const original = globalRegistry[BUS_SYMBOL];
  delete globalRegistry[BUS_SYMBOL];
  try {
    await run();
  } finally {
    if (hadOriginal) globalRegistry[BUS_SYMBOL] = original;
    else delete globalRegistry[BUS_SYMBOL];
  }
}

void test("creates a structural global bus before a bridge loads", async () => {
  await withCleanBus(() => {
    const bus = getUsageBusV1();
    const bridgeView = globalRegistry[BUS_SYMBOL] as ProviderUsageBusV1;
    const bridgeAdapter = adapter("bridge");

    bridgeView.register(bridgeAdapter);

    assert.strictEqual(bridgeView, bus);
    assert.strictEqual(getUsageBusV1(), bus);
    assert.deepEqual(bus.adapters(), [bridgeAdapter]);
  });
});

void test("reuses a compatible bus created by a bridge first", async () => {
  await withCleanBus(() => {
    const bridgeAdapter = adapter("bridge-first");
    const bridgeBus: ProviderUsageBusV1 = {
      version: 1,
      register: () => () => {},
      adapters: () => [bridgeAdapter],
      subscribe: () => () => {},
      publish: () => 0,
    };
    globalRegistry[BUS_SYMBOL] = bridgeBus;

    const usageBus = getUsageBusV1();

    assert.strictEqual(usageBus, bridgeBus);
    assert.deepEqual(usageBus.adapters(), [bridgeAdapter]);
  });
});

void test("replaces duplicate adapter ids deterministically and unregisters idempotently", async () => {
  await withCleanBus(() => {
    const bus = getUsageBusV1();
    const first = adapter("duplicate", ["first-provider"]);
    const other = adapter("other", ["other-provider"]);
    const replacement = adapter("duplicate", ["replacement-provider"]);
    const unregisterFirst = bus.register(first);
    const unregisterOther = bus.register(other);
    const unregisterReplacement = bus.register(replacement);

    assert.deepEqual(bus.adapters(), [replacement, other]);

    unregisterFirst();
    assert.deepEqual(bus.adapters(), [replacement, other]);

    unregisterReplacement();
    unregisterReplacement();
    assert.deepEqual(bus.adapters(), [other]);

    unregisterOther();
    unregisterOther();
    assert.deepEqual(bus.adapters(), []);
  });
});

void test("publishes to subscribers and returns the listener count", async () => {
  await withCleanBus(() => {
    const bus = getUsageBusV1();
    const received: string[] = [];
    const unsubscribeFirst = bus.subscribe((event) => received.push(`first:${event.type}`));
    const unsubscribeSecond = bus.subscribe((event) => received.push(`second:${event.type}`));
    const event: ProviderUsageEventV1 = { version: 1, type: "snapshot", snapshot: usageSnapshot() };

    assert.equal(bus.publish(event), 2);
    assert.deepEqual(received, ["first:snapshot", "second:snapshot"]);

    unsubscribeFirst();
    unsubscribeFirst();
    assert.equal(bus.publish(event), 1);
    assert.deepEqual(received, ["first:snapshot", "second:snapshot", "second:snapshot"]);

    unsubscribeSecond();
    assert.equal(bus.publish(event), 0);
  });
});

void test("rejects an incompatible preexisting global bus version", async () => {
  await withCleanBus(() => {
    globalRegistry[BUS_SYMBOL] = { version: 2 };

    assert.throws(() => getUsageBusV1(), /incompatible.*version.*2/i);
    assert.deepEqual(globalRegistry[BUS_SYMBOL], { version: 2 });
  });
});

void test("supports and queries a non-native model through its adapter", async () => {
  await withCleanBus(async () => {
    let refreshOptions: { timeoutMs: number; signal?: AbortSignal } | undefined;
    getUsageBusV1().register(
      adapter("query-bridge", ["bridge-provider"], async (options) => {
        refreshOptions = options;
        return usageSnapshot(140);
      }),
    );
    const model = { provider: "bridge-provider", id: "bridge-model", name: "Bridge Model" };
    const ctx = { model } as unknown as ExtensionContext;

    assert.equal(isUsageSupportedModel(model), true);
    const result = await queryUsage(ctx, { timeoutMs: 4321 });

    assert.deepEqual(refreshOptions, { timeoutMs: 4321 });
    assert.deepEqual(result, {
      ok: true,
      report: {
        provider: "codex",
        source: "external-adapter",
        capturedAt: Date.parse("2026-09-12T13:00:00Z"),
        windows: [
          {
            id: "gpt:five_hour",
            label: "5h",
            usedPercent: 100,
            scope: { kind: "account" },
          },
        ],
      },
    });
  });
});

void test("reports adapter refresh failures as external-adapter errors", async () => {
  await withCleanBus(async () => {
    const failure = new Error("bridge refresh failed");
    getUsageBusV1().register(adapter("failing-bridge", ["failing-provider"], async () => Promise.reject(failure)));
    const ctx = {
      model: { provider: "failing-provider", id: "failing-model", name: "Failing Model" },
    } as unknown as ExtensionContext;

    const result = await queryUsage(ctx, { timeoutMs: 100 });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.source, "external-adapter");
    assert.equal(result.errors[0]?.message, "bridge refresh failed");
    assert.strictEqual(result.errors[0]?.cause, failure);
  });
});
