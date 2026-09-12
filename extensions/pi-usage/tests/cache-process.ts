import { type ChildProcess, fork } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type MutationLockPhase = "after-open" | "after-acquire" | "before-cache-replace" | "after-cache-replace";

const childFixture = fileURLToPath(new URL("./fixtures/shared-cache-child.ts", import.meta.url));
const packageDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function startCacheChild(args: string[]): ChildProcess {
  return fork(childFixture, args, {
    cwd: packageDirectory,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}

export function startCacheWriter(cacheFile: string, now: number, provider: "codex" | "anthropic"): ChildProcess {
  return startCacheChild(["write", cacheFile, String(now), provider]);
}

export function startPausedCacheWriter(
  cacheFile: string,
  now: number,
  provider: "codex" | "anthropic",
  phase: MutationLockPhase,
  controlFile: string,
): ChildProcess {
  return startCacheChild(["paused-write", cacheFile, String(now), provider, phase, controlFile]);
}

export function waitForChildMessage(child: ChildProcess, type: "ready" | "done"): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timeout = setTimeout(() => finish(new Error(`child timed out waiting for ${type}`)), 10_000);
    const onMessage = (message: unknown) => {
      if (typeof message === "object" && message !== null && Reflect.get(message, "type") === type) finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`child exited before ${type}: code=${String(code)} signal=${String(signal)} ${stderr}`));
    };
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

export function waitForMutationPhase(
  child: ChildProcess,
  controlFile: string,
  phase: MutationLockPhase,
): Promise<void> {
  const readyFile = `${controlFile}.${phase}.ready`;
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timeout = setTimeout(() => finish(new Error(`child timed out at mutation phase ${phase}`)), 10_000);
    const poll = setInterval(() => {
      if (existsSync(readyFile)) finish();
    }, 5);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(
        new Error(
          `child exited before mutation phase ${phase}: code=${String(code)} signal=${String(signal)} ${stderr}`,
        ),
      );
    };
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      clearInterval(poll);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    child.on("exit", onExit);
  });
}

export function resumeMutationPhase(controlFile: string, phase: MutationLockPhase): void {
  writeFileSync(`${controlFile}.${phase}.resume`, "resume");
}

export function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForChildExit(child);
  child.kill("SIGKILL");
  await exited;
}
