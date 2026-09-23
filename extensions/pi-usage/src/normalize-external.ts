import type {
  AdapterUsageReport,
  NormalizedUsageWindow,
  ProviderUsageSnapshotV1,
  UsageScopeV1,
  UsageStateV1,
} from "./types.js";
import { clampPercent } from "./utils.js";

export function normalizeExternalUsageSnapshot(
  snapshot: ProviderUsageSnapshotV1,
  modelProviders: readonly string[],
): AdapterUsageReport {
  assertProviderUsageSnapshotV1(snapshot);
  if (
    !Array.isArray(modelProviders) ||
    modelProviders.length === 0 ||
    !modelProviders.every((provider) => isNonEmptyString(provider))
  ) {
    throw new Error("External adapter modelProviders must be a non-empty array of strings.");
  }

  return {
    provider: snapshot.provider,
    ...(snapshot.providerLabel === undefined ? {} : { providerLabel: snapshot.providerLabel }),
    source: "external-adapter",
    snapshotSource: snapshot.source,
    ...(snapshot.adapterId === undefined ? {} : { adapterId: snapshot.adapterId }),
    complete: snapshot.complete,
    modelProviders: [...modelProviders],
    capturedAt: snapshot.capturedAt,
    windows: snapshot.windows.map(normalizeExternalWindow),
  };
}

export function isProviderUsageSnapshotV1(value: unknown): value is ProviderUsageSnapshotV1 {
  try {
    assertProviderUsageSnapshotV1(value);
    return true;
  } catch {
    return false;
  }
}

function assertProviderUsageSnapshotV1(value: unknown): asserts value is ProviderUsageSnapshotV1 {
  if (!isRecord(value)) throw new Error("External usage snapshot must be an object.");
  if (value.version !== 1) {
    throw new Error(`Unsupported external usage snapshot version: ${String(value.version)}.`);
  }
  if (value.provider !== "claude" && value.provider !== "codex") {
    throw new Error("External usage snapshot provider must be claude or codex.");
  }
  if (value.providerLabel !== undefined && !isNonEmptyString(value.providerLabel)) {
    throw new Error("External usage snapshot providerLabel must be a non-empty string.");
  }
  if (!isNonEmptyString(value.source)) {
    throw new Error("External usage snapshot source must be a non-empty string.");
  }
  if (!isFiniteNonNegativeNumber(value.capturedAt)) {
    throw new Error("External usage snapshot capturedAt must be a finite epoch-millisecond value.");
  }
  if (typeof value.complete !== "boolean") {
    throw new Error("External usage snapshot complete must be a boolean.");
  }
  if (value.adapterId !== undefined && !isNonEmptyString(value.adapterId)) {
    throw new Error("External usage snapshot adapterId must be a non-empty string.");
  }
  if (!Array.isArray(value.windows)) {
    throw new Error("External usage snapshot windows must be an array.");
  }
  value.windows.forEach(normalizeExternalWindow);
}

function normalizeExternalWindow(window: unknown, index: number): NormalizedUsageWindow {
  if (!isRecord(window)) throw new Error(`External usage window ${index} must be an object.`);
  if (!isNonEmptyString(window.id)) throw new Error(`External usage window ${index} id must be a non-empty string.`);
  if (!isNonEmptyString(window.label)) {
    throw new Error(`External usage window ${index} label must be a non-empty string.`);
  }
  if (window.usedPercent !== undefined && !isFiniteNumber(window.usedPercent)) {
    throw new Error(`External usage window ${index} usedPercent must be finite.`);
  }
  if (window.resetsAt !== undefined && !isFiniteNonNegativeNumber(window.resetsAt)) {
    throw new Error(`External usage window ${index} resetsAt must be a finite epoch-second value.`);
  }
  if (window.windowMinutes !== undefined && !isFinitePositiveNumber(window.windowMinutes)) {
    throw new Error(`External usage window ${index} windowMinutes must be finite and positive.`);
  }
  if (window.state !== undefined && !isUsageState(window.state)) {
    throw new Error(`External usage window ${index} state is invalid.`);
  }
  for (const field of ["usedAmount", "limitAmount"] as const) {
    if (window[field] !== undefined && !isFiniteNonNegativeNumber(window[field])) {
      throw new Error(`External usage window ${index} ${field} must be finite and non-negative.`);
    }
  }
  if (window.currency !== undefined && !isNonEmptyString(window.currency)) {
    throw new Error(`External usage window ${index} currency must be a non-empty string.`);
  }

  const usedAmount = window.usedAmount as number | undefined;
  const limitAmount = window.limitAmount as number | undefined;
  return {
    id: window.id,
    label: window.label,
    ...(window.usedPercent === undefined ? {} : { usedPercent: clampPercent(window.usedPercent) }),
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    ...(window.windowMinutes === undefined ? {} : { windowMinutes: window.windowMinutes }),
    scope: normalizeExternalScope(window.scope, index),
    ...(window.state === undefined ? {} : { state: window.state }),
    ...(usedAmount === undefined ? {} : { usedAmount }),
    ...(limitAmount === undefined ? {} : { limitAmount }),
    ...(window.currency === undefined ? {} : { currency: window.currency }),
  };
}

function normalizeExternalScope(scope: unknown, index: number): UsageScopeV1 {
  if (!isRecord(scope)) throw new Error(`External usage window ${index} scope must be an object.`);
  if (scope.kind === "account") return { kind: "account" };
  if (scope.kind === "overage") return { kind: "overage" };
  if (scope.kind === "provider") {
    if (!isNonEmptyString(scope.id)) throw new Error(`External usage window ${index} provider scope id is invalid.`);
    if (scope.label !== undefined && !isNonEmptyString(scope.label)) {
      throw new Error(`External usage window ${index} provider scope label is invalid.`);
    }
    return { kind: "provider", id: scope.id, ...(scope.label === undefined ? {} : { label: scope.label }) };
  }
  if (scope.kind !== "model") throw new Error(`External usage window ${index} has an unsupported scope kind.`);
  if (
    !Array.isArray(scope.modelIds) ||
    scope.modelIds.length === 0 ||
    !scope.modelIds.every((modelId) => isNonEmptyString(modelId))
  ) {
    throw new Error(`External usage window ${index} modelIds must be a non-empty array of strings.`);
  }
  if (!isNonEmptyString(scope.label)) {
    throw new Error(`External usage window ${index} model scope label must be a non-empty string.`);
  }
  return { kind: "model", modelIds: [...scope.modelIds], label: scope.label };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUsageState(value: unknown): value is UsageStateV1 {
  return value === "available" || value === "warning" || value === "rejected" || value === "unknown";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
