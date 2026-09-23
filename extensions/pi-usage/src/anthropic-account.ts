import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve the Anthropic account the OAuth usage is charged against.
 *
 * Read at DISPLAY time only — the account email is NEVER written to
 * usage-cache.json (the README guarantees the cache holds no account
 * identifiers). Best-effort: returns `undefined` on any error and never throws.
 * The config path is a parameter (defaulting to `~/.claude.json`) so tests can
 * inject a fixture. */
export function resolveAnthropicAccountEmail(
  claudeConfigPath: string = join(homedir(), ".claude.json"),
): string | undefined {
  try {
    const raw = readFileSync(claudeConfigPath, "utf8");
    const parsed = JSON.parse(raw) as { oauthAccount?: { emailAddress?: unknown } };
    const email = parsed?.oauthAccount?.emailAddress;
    if (typeof email === "string" && email.trim().length > 0) return email.trim();
    return undefined;
  } catch {
    return undefined;
  }
}
