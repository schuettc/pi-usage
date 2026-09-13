import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyProviderUsageSnapshot } from "./statusline.js";
import type { ProviderUsageEventV1, UsageProviderKey } from "./types.js";

export const PROVIDER_USAGE_WARNING_ENTRY_TYPE = "provider-usage:warning-v1";

type ProviderWarningMarker = {
  provider: UsageProviderKey;
  shownAt: number;
};

const shownSoftWarnings = new WeakMap<ExtensionAPI, Set<UsageProviderKey>>();

function isUsageProvider(value: unknown): value is UsageProviderKey {
  return value === "anthropic" || value === "codex";
}

/** Rebuild the per-session warning allowance from durable custom entries. */
export function restoreProviderWarningState(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const restored = new Set<UsageProviderKey>();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== PROVIDER_USAGE_WARNING_ENTRY_TYPE) continue;
    const data = entry.data;
    if (typeof data !== "object" || data === null) continue;
    const provider = Reflect.get(data, "provider");
    if (isUsageProvider(provider)) restored.add(provider);
  }
  shownSoftWarnings.set(pi, restored);
}

/** Apply all attached usage data, then present the event under the durable
 * once-per-provider soft-warning policy. */
export function handleProviderUsageEvent(pi: ExtensionAPI, ctx: ExtensionContext, event: ProviderUsageEventV1): void {
  const attachedSnapshot = event.snapshot;
  if (attachedSnapshot) applyProviderUsageSnapshot(ctx, attachedSnapshot);
  if (event.type === "snapshot") return;

  if (event.type === "hard-limit") {
    ctx.ui.notify(event.message, "warning");
    return;
  }

  const shown = shownSoftWarnings.get(pi) ?? new Set<UsageProviderKey>();
  if (shown.has(event.provider)) return;

  const marker: ProviderWarningMarker = { provider: event.provider, shownAt: Date.now() };
  pi.appendEntry(PROVIDER_USAGE_WARNING_ENTRY_TYPE, marker);
  shown.add(event.provider);
  shownSoftWarnings.set(pi, shown);
  ctx.ui.notify(event.message, "warning");
}
