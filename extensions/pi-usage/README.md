# @sreetej510/pi-usage

A [pi](https://github.com/earendil-works/pi) coding agent extension that reports provider
usage / rate-limit budgets — OpenAI Codex, Anthropic OAuth, and pi-auth-backed providers — via
`/usage`, with a live statusline widget.

## What it does

- Queries the active model's provider usage endpoint (Codex app-server usage/rate-limit-reset
  APIs, or Anthropic's OAuth usage API) and renders remaining budget/reset windows.
- Caches results on disk (`~/.pi/agent/usage-cache.json`) for a few minutes so multiple
  concurrent pi sessions don't hammer the provider APIs.
- Pushes a compact usage summary into the statusline, refreshed automatically with retry/backoff
  on rate limits (`429`).
- Shows the next Codex banked-reset expiry and supports confirmed, interactive consumption.

## Provider support
- OpenAI Codex through Pi auth, with the Codex app-server fallback.
- Anthropic OAuth through Pi auth.
- Optional provider adapters discovered at runtime. No Schuettc package is required.

## Optional provider adapter protocol

Adapters and consumers discover the V1 process-local registry through
`Symbol.for("pi.provider-usage.bus.v1")` (also exported as `PROVIDER_USAGE_BUS_SYMBOL`). An adapter has this structural shape:

```ts
{
  id: string;
  usageProvider: "claude" | "codex";
  modelProviders: string[];
  refresh(options: { timeoutMs: number; signal?: AbortSignal }): Promise<ProviderUsageSnapshotV1>;
}
```

Snapshots use the exported `ProviderUsageSnapshotV1`, `NormalizedUsageWindow`, `UsageScopeV1`, and
`UsageStateV1` types. Complete account refreshes replace an adapter/provider snapshot; partial passive
snapshots merge supplied windows and fields by stable scope/window identity. Unknown utilization is omitted,
not reported as zero. Malformed, incompatible, absent, or throwing optional registries fail open.

The usage extension owns once-per-provider warning notifications when subscribed. Providers may publish
`soft-warning` and `hard-limit` events; hard limits are always shown. A provider running without pi-usage must
keep its own standalone warning policy. Without any optional adapter, pi-usage remains standalone and uses its
native Codex and Anthropic OAuth queries and cache.

## Shared state
Snapshots are cached at `~/.pi/agent/usage-cache.json`. The cache contains normalized usage only, never access
tokens, raw responses, or account identifiers.

## Commands

| Command | Effect |
|---|---|
| `/usage` | Show cached usage (fetches fresh data if the cache is stale) |
| `/usage --refresh` | Force a fresh fetch, bypassing the cache |
| `/usage --timeout <seconds>` | Set the query timeout |
| `/usage --raw` | Show raw usage API responses (debugging) |
| `/usage --consume-banked-reset` | Select and consume a Codex banked reset after confirmation |

## Install

```bash
npm install -g @sreetej510/pi-usage
```

Then add it to your pi `settings.json`:

```json
{
  "packages": ["npm:@sreetej510/pi-usage"]
}
```

Or, for local development, point at the file directly:

```json
{
  "extensions": ["/absolute/path/to/pi-extensions/extensions/pi-usage/src/index.ts"]
}
```

## File layout

| File | Responsibility |
|---|---|
| `src/index.ts` | Extension entry point + session event wiring |
| `src/command.ts` | `/usage` command handler |
| `src/statusline.ts` | Statusline state, timers, background refresh |
| `src/footer.ts` | Custom footer with right-aligned usage status |
| `src/query.ts` | Top-level usage query orchestration |
| `src/codex-query.ts` | Codex pi-auth + app-server fallback queries |
| `src/anthropic-query.ts` | Anthropic OAuth usage queries |
| `src/codex-auth.ts` | Codex auth header resolution |
| `src/anthropic-auth.ts` | Anthropic auth header resolution |
| `src/codex-app-server.ts` | `codex app-server` RPC client |
| `src/codex-reset-credits.ts` | Banked reset list/consume/format |
| `src/normalize-codex.ts` | Codex backend + app-server payload normalization |
| `src/normalize-anthropic.ts` | Anthropic usage payload normalization |
| `src/format.ts` | Report/statusline formatting and display |
| `src/shared-cache.ts` | On-disk shared usage cache |
| `src/models.ts` | Provider/model matching helpers |
| `src/args.ts` | `/usage` argument parsing and completions |
| `src/constants.ts` | Shared constants |
| `src/types.ts` | Shared TypeScript types |
| `src/utils.ts` | Small parsing/formatting helpers |
| `src/errors.ts` | HTTP/rate-limit error helpers |
| `src/http.ts` | `fetchWithTimeout` wrapper |

## Development

```bash
npm install
npm run --workspace @sreetej510/pi-usage check     # biome + typecheck
npm run --workspace @sreetej510/pi-usage format
```
