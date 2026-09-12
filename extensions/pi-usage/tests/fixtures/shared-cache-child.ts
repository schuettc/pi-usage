import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { configureSharedCacheForTests, saveSharedUsageReport } from "../../src/shared-cache.js";
import type { UsageProviderKey, UsageReport } from "../../src/types.js";

const [mode, cacheFile, rawNow, rawProvider] = process.argv.slice(2);
const now = Number(rawNow);

if (!cacheFile || !Number.isFinite(now)) {
  throw new Error("shared-cache child requires a cache path and timestamp");
}

if (mode === "hold-lock") {
  writeFileSync(
    `${cacheFile}.lock`,
    JSON.stringify({
      pid: process.pid,
      token: `child-${process.pid}`,
      hostname: hostname(),
      acquiredAt: now,
    }),
  );
  process.send?.({ type: "ready" });
  setInterval(() => {}, 1_000);
} else if (mode === "write") {
  if (rawProvider !== "codex" && rawProvider !== "anthropic") {
    throw new Error("shared-cache writer requires a provider");
  }
  const provider: UsageProviderKey = rawProvider;
  configureSharedCacheForTests({ cacheFile, now: () => now });
  process.send?.({ type: "ready" });
  process.once("message", () => {
    const report: UsageReport =
      provider === "codex"
        ? {
            provider,
            source: "codex-app-server",
            capturedAt: now,
            snapshots: [{ limitId: "codex", primary: { usedPercent: 23, windowMinutes: 300 } }],
          }
        : {
            provider,
            source: "anthropic-oauth",
            capturedAt: now,
            windows: [],
            summaryLines: ["Anthropic usage"],
            statusline: "Claude usage",
          };
    saveSharedUsageReport(report, now);
    process.send?.({ type: "done" }, () => process.exit(0));
  });
} else {
  throw new Error(`unknown shared-cache child mode: ${String(mode)}`);
}
