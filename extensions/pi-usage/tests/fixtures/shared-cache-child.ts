import { existsSync, writeFileSync } from "node:fs";
import { configureSharedCacheForTests, saveSharedUsageReport } from "../../src/shared-cache.js";
import type { UsageProviderKey, UsageReport } from "../../src/types.js";
import type { MutationLockPhase } from "../cache-process.js";

const [mode, cacheFile, rawNow, rawProvider, rawPhase, controlFile] = process.argv.slice(2);
const now = Number(rawNow);

if (!cacheFile || !Number.isFinite(now)) {
  throw new Error("shared-cache child requires a cache path and timestamp");
}

const waitArray = new Int32Array(new SharedArrayBuffer(4));

function pauseAtMutationPhase(phase: MutationLockPhase): void {
  if (phase !== rawPhase || !controlFile) return;
  writeFileSync(`${controlFile}.${phase}.ready`, "ready");
  while (!existsSync(`${controlFile}.${phase}.resume`)) {
    Atomics.wait(waitArray, 0, 0, 10);
  }
}

function usageReport(provider: UsageProviderKey): UsageReport {
  return provider === "codex"
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
}

if (mode === "write" || mode === "paused-write") {
  if (rawProvider !== "codex" && rawProvider !== "claude") {
    throw new Error("shared-cache writer requires a provider");
  }
  const provider: UsageProviderKey = rawProvider;
  configureSharedCacheForTests({
    cacheFile,
    now: () => now,
    ...(mode === "paused-write" ? { mutationLockPhase: pauseAtMutationPhase } : {}),
  });
  process.send?.({ type: "ready" });
  const write = () => {
    saveSharedUsageReport(usageReport(provider), now);
    process.send?.({ type: "done" }, () => process.exit(0));
  };
  if (mode === "write") process.once("message", write);
  else write();
} else {
  throw new Error(`unknown shared-cache child mode: ${String(mode)}`);
}
