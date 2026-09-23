import { ANTHROPIC_NON_WINDOW_KEYS, USAGE_UNAVAILABLE_TEXT } from "./constants.js";
import { progressBarUsed } from "./format.js";
import type {
  AnthropicExtraUsage,
  AnthropicOAuthUsagePayload,
  AnthropicOAuthWindow,
  AnthropicUsageReport,
  NormalizedUsageWindow,
  UsageScopeV1,
} from "./types.js";
import {
  asBoolean,
  asNumber,
  asString,
  assertObject,
  clampPercent,
  compactLimitLabel,
  formatCurrencyAmount,
} from "./utils.js";

type EnterpriseWindow = {
  window: NormalizedUsageWindow;
  usedDollars: number;
  limitDollars: number;
};

type ExtraUsageWindow = {
  window: NormalizedUsageWindow;
  usedMajor: number;
  monthlyLimitMajor?: number;
  currency: string;
};

const ACCOUNT_SCOPE: UsageScopeV1 = { kind: "account" };
const ROLLING_WINDOWS = {
  five_hour: { label: "5h", windowMinutes: 5 * 60 },
  seven_day: { label: "7d", windowMinutes: 7 * 24 * 60 },
} as const;

export function normalizeAnthropicUsagePayload(
  payload: AnthropicOAuthUsagePayload,
  capturedAt: number,
): AnthropicUsageReport {
  const accountRollingWindows = normalizeRollingWindows(payload, ACCOUNT_SCOPE);
  const modelRollingWindows = normalizeModelScopedWindows(payload.model_scoped);
  const enterpriseWindows = normalizeEnterpriseWindows(payload);
  const extraUsage = normalizeExtraUsage(payload.extra_usage);
  const windows = [
    ...accountRollingWindows,
    ...modelRollingWindows,
    ...enterpriseWindows.map(({ window }) => window),
    ...(extraUsage ? [extraUsage.window] : []),
  ];

  if (windows.length === 0) {
    throw new Error("Anthropic usage endpoint returned no displayable usage data.");
  }

  return {
    provider: "claude",
    source: "anthropic-oauth",
    capturedAt,
    windows,
    summaryLines: formatAnthropicSummary(accountRollingWindows, modelRollingWindows, enterpriseWindows, extraUsage),
    statusline: formatLegacyAnthropicStatusline(
      accountRollingWindows,
      modelRollingWindows,
      enterpriseWindows,
      extraUsage,
    ),
  };
}

function normalizeRollingWindows(
  bucket: Record<string, unknown>,
  scope: UsageScopeV1,
  idPrefix?: string,
): NormalizedUsageWindow[] {
  const windows: NormalizedUsageWindow[] = [];
  for (const [key, metadata] of Object.entries(ROLLING_WINDOWS)) {
    const window = normalizeRollingWindow(bucket[key], idPrefix ? `${idPrefix}:${key}` : key, metadata.label, scope);
    if (window) windows.push({ ...window, windowMinutes: metadata.windowMinutes });
  }
  return windows;
}

function normalizeModelScopedWindows(value: unknown): NormalizedUsageWindow[] {
  if (value === null || value === undefined) return [];
  const modelScoped = assertObject(value, "Anthropic model-scoped usage");
  const windows: NormalizedUsageWindow[] = [];

  for (const [modelId, rawBucket] of Object.entries(modelScoped)) {
    if (!rawBucket || typeof rawBucket !== "object" || Array.isArray(rawBucket)) continue;
    const bucket = rawBucket as Record<string, unknown>;
    const scope: UsageScopeV1 = {
      kind: "model",
      modelIds: [modelId],
      label: titleCaseCompactLabel(modelId),
    };
    const knownWindows = normalizeRollingWindows(bucket, scope, modelId);
    windows.push(...knownWindows);

    for (const [key, rawWindow] of Object.entries(bucket)) {
      if (key in ROLLING_WINDOWS || !rawWindow || typeof rawWindow !== "object" || Array.isArray(rawWindow)) continue;
      const window = normalizeRollingWindow(rawWindow, `${modelId}:${key}`, titleCaseCompactLabel(key), scope);
      if (window) windows.push(window);
    }
  }

  return windows;
}

function normalizeRollingWindow(
  value: unknown,
  id: string,
  label: string,
  scope: UsageScopeV1,
): NormalizedUsageWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = assertObject(value, "Anthropic rolling usage window") as AnthropicOAuthWindow;
  const usedPercent = asNumber(window.utilization);
  if (usedPercent === undefined) return undefined;
  const resetsAt = isoToEpochSeconds(asString(window.resets_at));
  return {
    id,
    label,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    scope,
  };
}

function normalizeEnterpriseWindows(payload: AnthropicOAuthUsagePayload): EnterpriseWindow[] {
  const windows: EnterpriseWindow[] = [];
  for (const [key, rawValue] of Object.entries(payload)) {
    if (ANTHROPIC_NON_WINDOW_KEYS.has(key)) continue;
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) continue;
    const value = rawValue as AnthropicOAuthWindow;
    const limitDollars = asNumber(value.limit_dollars);
    const usedDollars = asNumber(value.used_dollars);
    if (limitDollars === undefined || usedDollars === undefined) continue;
    const resetsAt = isoToEpochSeconds(asString(value.resets_at));
    windows.push({
      window: {
        id: key,
        label: titleCaseCompactLabel(key),
        ...(asNumber(value.utilization) === undefined
          ? {}
          : { usedPercent: clampPercent(asNumber(value.utilization) as number) }),
        ...(resetsAt === undefined ? {} : { resetsAt }),
        scope: ACCOUNT_SCOPE,
        usedAmount: usedDollars,
        limitAmount: limitDollars,
        currency: "USD",
      },
      usedDollars,
      limitDollars,
    });
  }
  return windows.sort((left, right) => left.limitDollars - right.limitDollars);
}

function normalizeExtraUsage(value: unknown): ExtraUsageWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const extraUsage = assertObject(value, "Anthropic extra usage") as AnthropicExtraUsage;
  const enabled = asBoolean(extraUsage.is_enabled);
  const usedCredits = asNumber(extraUsage.used_credits);
  if (!enabled || usedCredits === undefined) return undefined;

  const monthlyLimit = asNumber(extraUsage.monthly_limit);
  const resetsAt = isoToEpochSeconds(asString(extraUsage.reset_at) ?? asString(extraUsage.resets_at));
  return {
    window: {
      id: "extra_usage",
      label: "overage",
      ...(asNumber(extraUsage.utilization) === undefined
        ? {}
        : { usedPercent: clampPercent(asNumber(extraUsage.utilization) as number) }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      scope: { kind: "overage" },
      state: "available",
      usedAmount: usedCredits / 100,
      ...(monthlyLimit === undefined ? {} : { limitAmount: monthlyLimit / 100 }),
      currency: asString(extraUsage.currency) ?? "USD",
    },
    usedMajor: usedCredits / 100,
    monthlyLimitMajor: monthlyLimit === undefined ? undefined : monthlyLimit / 100,
    currency: asString(extraUsage.currency) ?? "USD",
  };
}

function formatAnthropicSummary(
  accountRollingWindows: NormalizedUsageWindow[],
  modelRollingWindows: NormalizedUsageWindow[],
  enterpriseWindows: EnterpriseWindow[],
  extraUsage: ExtraUsageWindow | undefined,
): string[] {
  const lines = ["  >_ Anthropic Usage", ""];
  let hasAnySection = false;

  if (enterpriseWindows.length > 0) {
    hasAnySection = true;
    lines.push("  Enterprise budget windows:");
    for (const { window, usedDollars, limitDollars } of enterpriseWindows) {
      const reset = window.resetsAt ? ` (resets ${formatReset(window.resetsAt)})` : "";
      const utilization =
        window.usedPercent === undefined
          ? USAGE_UNAVAILABLE_TEXT
          : `${progressBarUsed(window.usedPercent)} ${window.usedPercent.toFixed(0)}% used`;
      lines.push(
        `  ${window.label}: ${utilization} (${formatCurrencyAmount(usedDollars, "USD")}/${formatCurrencyAmount(limitDollars, "USD")})${reset}`,
      );
    }
  }

  if (extraUsage) {
    if (hasAnySection) lines.push("");
    hasAnySection = true;
    const { window, usedMajor, monthlyLimitMajor, currency } = extraUsage;
    const amount = `${formatCurrencyAmount(usedMajor, currency)}${monthlyLimitMajor !== undefined ? `/${formatCurrencyAmount(monthlyLimitMajor, currency)}` : ""}`;
    const reset = window.resetsAt ? ` (resets ${formatReset(window.resetsAt)})` : "";
    lines.push("  Monthly extra usage:");
    const utilization =
      window.usedPercent === undefined
        ? USAGE_UNAVAILABLE_TEXT
        : `${progressBarUsed(window.usedPercent)} ${window.usedPercent.toFixed(0)}% used`;
    lines.push(`  ${utilization} ${amount}${reset}`);
  }

  if (accountRollingWindows.length > 0) {
    if (hasAnySection) lines.push("");
    hasAnySection = true;
    lines.push("  Subscription usage:");
    for (const window of accountRollingWindows) lines.push(`  ${formatRollingWindow(window)}`);
  }

  const modelScopes = groupModelWindows(modelRollingWindows);
  for (const { label, windows } of modelScopes) {
    if (hasAnySection) lines.push("");
    hasAnySection = true;
    lines.push(`  ${label} usage:`);
    for (const window of windows) lines.push(`  ${formatRollingWindow(window)}`);
  }

  return lines;
}

function formatLegacyAnthropicStatusline(
  accountRollingWindows: NormalizedUsageWindow[],
  modelRollingWindows: NormalizedUsageWindow[],
  enterpriseWindows: EnterpriseWindow[],
  extraUsage: ExtraUsageWindow | undefined,
): string {
  const statusParts = ["claude"];

  if (enterpriseWindows.length > 0) {
    const primary = [...enterpriseWindows].sort(
      (left, right) => (right.window.usedPercent ?? -1) - (left.window.usedPercent ?? -1),
    )[0];
    if (primary.window.usedPercent !== undefined) statusParts.push(`${primary.window.usedPercent.toFixed(0)}%`);
    statusParts.push(
      `${formatCurrencyAmount(primary.usedDollars, "USD", 0)}/${formatCurrencyAmount(primary.limitDollars, "USD", 0)}`,
    );
  }

  if (extraUsage) {
    const hadStatusSegment = statusParts.length > 1;
    const { window, usedMajor, monthlyLimitMajor, currency } = extraUsage;
    const amount = `${formatCurrencyAmount(usedMajor, currency, 0)}${monthlyLimitMajor !== undefined ? `/${formatCurrencyAmount(monthlyLimitMajor, currency, 0)}` : ""}`;
    if (window.usedPercent !== undefined) statusParts.push(`${window.usedPercent.toFixed(0)}%`);
    statusParts.push(amount);
    if (hadStatusSegment) statusParts.push("extra");
  }

  if (statusParts.length === 1) {
    const rollingWindows = accountRollingWindows.length > 0 ? accountRollingWindows : modelRollingWindows;
    for (const window of rollingWindows) {
      if (window.usedPercent !== undefined) statusParts.push(`${window.usedPercent.toFixed(0)}% ${window.label}`);
    }
  }

  return statusParts.join(" ");
}

function groupModelWindows(
  modelWindows: NormalizedUsageWindow[],
): { label: string; windows: NormalizedUsageWindow[] }[] {
  const groups = new Map<string, { label: string; windows: NormalizedUsageWindow[] }>();
  for (const window of modelWindows) {
    if (window.scope.kind !== "model") continue;
    const key = JSON.stringify(window.scope.modelIds);
    const group = groups.get(key) ?? { label: window.scope.label, windows: [] };
    group.windows.push(window);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function formatRollingWindow(window: NormalizedUsageWindow): string {
  const reset = window.resetsAt ? ` (resets ${formatReset(window.resetsAt, window.label !== "5h")})` : "";
  const utilization =
    window.usedPercent === undefined
      ? USAGE_UNAVAILABLE_TEXT
      : `${progressBarUsed(window.usedPercent)} ${window.usedPercent.toFixed(0)}% used`;
  return `${window.label}: ${utilization}${reset}`;
}

function isoToEpochSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const epochMilliseconds = Date.parse(value);
  return Number.isFinite(epochMilliseconds) ? epochMilliseconds / 1000 : undefined;
}

function titleCaseCompactLabel(value: string): string {
  return compactLimitLabel(value).replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatReset(epochSeconds: number, showDay = true): string {
  const reset = new Date(epochSeconds * 1000);
  const now = new Date();
  const time = `${reset.getHours().toString().padStart(2, "0")}:${reset.getMinutes().toString().padStart(2, "0")}`;
  if (!showDay && reset.toDateString() === now.toDateString()) return time;
  const day = reset.getDate().toString();
  const month = reset.toLocaleDateString(undefined, { month: "short" });
  return `${time} on ${day} ${month}`;
}
