import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getUsageBusV1 } from "../src/adapter-bus.js";
import usageExtension from "../src/index.js";
import type { ProviderUsageBusV1, ProviderUsageEventV1 } from "../src/types.js";
import { PROVIDER_USAGE_WARNING_ENTRY_TYPE } from "../src/warnings.js";

const BUS_SYMBOL = Symbol.for("pi.provider-usage.bus.v1");
const globalRegistry = globalThis as typeof globalThis & Record<symbol, unknown>;
const hardLimit: ProviderUsageEventV1 = {
  version: 1,
  type: "hard-limit",
  provider: "codex",
  message: "Codex hard limit",
};
const softWarning: ProviderUsageEventV1 = {
  version: 1,
  type: "soft-warning",
  provider: "codex",
  message: "Codex soft warning",
};

type LifecycleEvent =
  | { type: "session_start"; reason: "startup" | "reload" | "new" | "resume" | "fork" }
  | { type: "session_shutdown"; reason: "quit" | "reload" | "new" | "resume" | "fork" };
type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
type FakePi = {
  api: ExtensionAPI;
  appended: Array<{ customType: string; data: unknown }>;
  emit: (event: LifecycleEvent, ctx: ExtensionContext) => Promise<void>;
};

function fakePi(): FakePi {
  const handlers = new Map<string, LifecycleHandler[]>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const api = {
    appendEntry: (customType: string, data?: unknown) => appended.push({ customType, data }),
    on: (event: string, handler: LifecycleHandler) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  return {
    api,
    appended,
    emit: async (event, ctx) => {
      for (const handler of handlers.get(event.type) ?? []) await handler(event, ctx);
    },
  };
}

function context(entries: unknown[] = [], notifications: string[] = []): ExtensionContext {
  return {
    hasUI: false,
    model: undefined,
    sessionManager: { getEntries: () => entries },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
    },
  } as unknown as ExtensionContext;
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

void test("restores warning markers before subscribing when a session resumes", async () => {
  await withCleanBus(async () => {
    const notifications: string[] = [];
    let subscribeCalls = 0;
    const bus: ProviderUsageBusV1 = {
      version: 1,
      adapters: () => [],
      publish: () => 0,
      register: () => () => {},
      subscribe: (listener) => {
        subscribeCalls += 1;
        listener(softWarning);
        return () => {};
      },
    };
    globalRegistry[BUS_SYMBOL] = bus;
    const pi = fakePi();
    usageExtension(pi.api);
    const marker = {
      type: "custom",
      customType: PROVIDER_USAGE_WARNING_ENTRY_TYPE,
      data: { provider: "codex", shownAt: 1 },
    };

    await pi.emit({ type: "session_start", reason: "resume" }, context([marker], notifications));

    assert.equal(subscribeCalls, 1);
    assert.deepEqual(notifications, []);
    assert.deepEqual(pi.appended, []);
  });
});

void test("starts a fork with a fresh allowance despite inherited warning markers", async () => {
  await withCleanBus(async () => {
    const notifications: string[] = [];
    const pi = fakePi();
    usageExtension(pi.api);
    const inheritedMarker = {
      type: "custom",
      customType: PROVIDER_USAGE_WARNING_ENTRY_TYPE,
      data: { provider: "codex", shownAt: 1 },
    };

    await pi.emit({ type: "session_start", reason: "fork" }, context([inheritedMarker], notifications));
    const bus = getUsageBusV1();
    assert.equal(bus.publish(softWarning), 1);

    assert.deepEqual(notifications, ["Codex soft warning"]);
    assert.equal(pi.appended.length, 1);
  });
});

void test("replaces the old session listener, resets unmarked allowances, and unsubscribes on shutdown", async () => {
  await withCleanBus(async () => {
    const firstNotifications: string[] = [];
    const secondNotifications: string[] = [];
    const pi = fakePi();
    usageExtension(pi.api);
    const firstContext = context([], firstNotifications);
    const secondContext = context([], secondNotifications);

    await pi.emit({ type: "session_start", reason: "startup" }, firstContext);
    const bus = getUsageBusV1();
    assert.equal(bus.publish(softWarning), 1);
    assert.deepEqual(firstNotifications, ["Codex soft warning"]);

    await pi.emit({ type: "session_start", reason: "new" }, secondContext);
    assert.equal(bus.publish(softWarning), 1);
    assert.deepEqual(firstNotifications, ["Codex soft warning"]);
    assert.deepEqual(secondNotifications, ["Codex soft warning"]);

    await pi.emit({ type: "session_shutdown", reason: "quit" }, secondContext);
    assert.equal(bus.publish(hardLimit), 0);
    assert.equal(pi.appended.length, 2);
  });
});

void test("contains a stale subscribed context and removes its listener", async () => {
  await withCleanBus(async () => {
    const staleMessage = "This extension ctx is stale after session replacement or reload";
    const staleContext = {
      hasUI: false,
      model: undefined,
      sessionManager: { getEntries: () => [] },
      ui: {
        notify: () => {
          throw new Error(staleMessage);
        },
        setStatus: () => {},
      },
    } as unknown as ExtensionContext;
    const pi = fakePi();
    usageExtension(pi.api);

    await pi.emit({ type: "session_start", reason: "startup" }, staleContext);
    const bus = getUsageBusV1();
    assert.equal(bus.publish(hardLimit), 1);
    assert.equal(bus.publish(hardLimit), 0);
  });
});

void test("runs standalone by creating a bus when no bridge adapter is present", async () => {
  await withCleanBus(async () => {
    const notifications: string[] = [];
    const pi = fakePi();
    usageExtension(pi.api);

    await pi.emit({ type: "session_start", reason: "startup" }, context([], notifications));
    const bus = getUsageBusV1();

    assert.deepEqual(bus.adapters(), []);
    assert.equal(bus.publish(hardLimit), 1);
    assert.deepEqual(notifications, ["Codex hard limit"]);
  });
});
