import { isProviderUsageSnapshotV1 } from "./normalize-external.js";
import type { ProviderUsageAdapterV1, ProviderUsageBusV1, ProviderUsageEventV1 } from "./types.js";

export const PROVIDER_USAGE_BUS_SYMBOL = Symbol.for("pi.provider-usage.bus.v1");
const globalRegistry = globalThis as typeof globalThis & Record<symbol, unknown>;

export function getUsageBusV1(): ProviderUsageBusV1 {
  const existing = globalRegistry[PROVIDER_USAGE_BUS_SYMBOL];
  if (existing !== undefined) {
    if (typeof existing !== "object" || existing === null) {
      throw new Error("Incompatible provider usage bus version undefined; expected version 1.");
    }
    const version = Reflect.get(existing, "version");
    if (version !== 1) {
      throw new Error(`Incompatible provider usage bus version ${String(version)}; expected version 1.`);
    }
    for (const method of ["register", "adapters", "subscribe", "publish"] as const) {
      if (typeof Reflect.get(existing, method) !== "function") {
        throw new Error(`Incompatible provider usage bus version 1: ${method} must be a function.`);
      }
    }
    return existing as ProviderUsageBusV1;
  }

  const bus = createUsageBusV1();
  globalRegistry[PROVIDER_USAGE_BUS_SYMBOL] = bus;
  return bus;
}

/** Optional protocol access for lifecycle/model/query paths. */
export function getOptionalUsageBusV1(): ProviderUsageBusV1 | undefined {
  try {
    return getUsageBusV1();
  } catch {
    return undefined;
  }
}

export function getUsageAdaptersV1(): ProviderUsageAdapterV1[] {
  try {
    const adapters = getOptionalUsageBusV1()?.adapters();
    return Array.isArray(adapters) ? adapters.filter(isProviderUsageAdapterV1) : [];
  } catch {
    return [];
  }
}

function createUsageBusV1(): ProviderUsageBusV1 {
  const adaptersById = new Map<string, { adapter: ProviderUsageAdapterV1; registration: symbol }>();
  const listeners = new Set<(event: ProviderUsageEventV1) => void>();

  return {
    version: 1,
    register(adapter) {
      if (!isProviderUsageAdapterV1(adapter)) return () => {};
      const registration = Symbol(adapter.id);
      adaptersById.set(adapter.id, { adapter, registration });
      return () => {
        if (adaptersById.get(adapter.id)?.registration === registration) {
          adaptersById.delete(adapter.id);
        }
      };
    },
    adapters() {
      return [...adaptersById.values()].map(({ adapter }) => adapter);
    },
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(event) {
      if (!isProviderUsageEventV1(event)) return 0;
      let invoked = 0;
      for (const listener of [...listeners]) {
        invoked += 1;
        try {
          listener(event);
        } catch {
          // Listener failures are isolated so every snapshot subscriber is attempted.
        }
      }
      return invoked;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isProvider(value: unknown): value is "claude" | "codex" {
  return value === "claude" || value === "codex";
}

function isProviderUsageAdapterV1(value: unknown): value is ProviderUsageAdapterV1 {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    isProvider(value.usageProvider) &&
    Array.isArray(value.modelProviders) &&
    value.modelProviders.length > 0 &&
    value.modelProviders.every(nonEmptyString) &&
    typeof value.refresh === "function"
  );
}

export function isProviderUsageEventV1(value: unknown): value is ProviderUsageEventV1 {
  if (!isRecord(value) || value.version !== 1) return false;
  if (value.type === "snapshot") return isProviderUsageSnapshotV1(value.snapshot);
  return (
    (value.type === "soft-warning" || value.type === "hard-limit") &&
    isProvider(value.provider) &&
    nonEmptyString(value.message) &&
    (value.snapshot === undefined ||
      (isProviderUsageSnapshotV1(value.snapshot) && value.snapshot.provider === value.provider))
  );
}
