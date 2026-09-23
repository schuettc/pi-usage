import assert from "node:assert/strict";
import test from "node:test";
import { formatCodexUsageReport, formatUsageReport, formatUsageStatusline } from "../src/format.js";
import { reportMatchesModel } from "../src/models.js";
import { normalizeAnthropicUsagePayload } from "../src/normalize-anthropic.js";
import type { AdapterUsageReport, CodexUsageReport, ProviderUsageModel } from "../src/types.js";

const now = Date.parse("2026-09-12T13:00:00Z");
const anthropicReport = normalizeAnthropicUsagePayload(
  {
    five_hour: { utilization: 23, resets_at: "2026-09-12T16:00:00Z" },
    seven_day: { utilization: 12, resets_at: "2026-09-18T12:00:00Z" },
    model_scoped: {
      fable: {
        five_hour: { utilization: 75, resets_at: "2026-09-12T15:00:00Z" },
        seven_day: { utilization: 41, resets_at: "2026-09-18T00:00:00Z" },
      },
    },
  },
  now,
);
const financialAnthropicReport = normalizeAnthropicUsagePayload(
  {
    cinder_cove: { utilization: 60, used_dollars: 5, limit_dollars: 10 },
    extra_usage: {
      is_enabled: true,
      utilization: 50,
      used_credits: 500,
      monthly_limit: 1000,
      currency: "USD",
    },
    model_scoped: {
      fable: {
        five_hour: { utilization: 75, resets_at: "2026-09-12T15:00:00Z" },
        seven_day: { utilization: 41, resets_at: "2026-09-18T00:00:00Z" },
      },
    },
  },
  now,
);
const nativeCodexReport: CodexUsageReport = {
  provider: "codex",
  source: "pi-auth",
  capturedAt: now,
  snapshots: [
    {
      limitId: "codex",
      primary: {
        usedPercent: 88,
        windowMinutes: 7 * 24 * 60,
        resetsAt: (now + 6 * 24 * 60 * 60_000) / 1000,
      },
    },
    {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 0, windowMinutes: 5 * 60, resetsAt: (now + 4 * 60 * 60_000) / 1000 },
      secondary: {
        usedPercent: 8,
        windowMinutes: 7 * 24 * 60,
        resetsAt: (now + 6 * 24 * 60 * 60_000) / 1000,
      },
    },
  ],
};
const codexAdapterReport: AdapterUsageReport = {
  provider: "codex",
  source: "external-adapter",
  snapshotSource: "test-adapter",
  complete: true,
  modelProviders: ["openai-codex"],
  capturedAt: now,
  windows: [
    {
      id: "gpt:five_hour",
      label: "5h",
      usedPercent: 32,
      resetsAt: (now + 47 * 60_000) / 1000,
      windowMinutes: 300,
      scope: { kind: "model", modelIds: ["gpt-5.1-codex"], label: "GPT" },
    },
    {
      id: "gpt:seven_day",
      label: "7d",
      usedPercent: 18,
      resetsAt: Date.parse("2026-09-18T00:00:00Z") / 1000,
      windowMinutes: 7 * 24 * 60,
      scope: { kind: "model", modelIds: ["gpt-5.1-codex"], label: "GPT" },
    },
  ],
};

function model(provider: string, id: string, name: string): ProviderUsageModel {
  return { provider, id, name } as ProviderUsageModel;
}

void test("renders matching Anthropic model windows before account windows", () => {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    assert.equal(
      formatUsageStatusline(anthropicReport, model("anthropic", "fable", "Claude Fable")),
      "Claude · Fable 5h 75% ↻2h · Fable 7d 41% ↻5d",
    );
  } finally {
    Date.now = originalNow;
  }
});

void test("preserves native Anthropic financial status while rendering matched model windows compactly", () => {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    assert.equal(financialAnthropicReport.statusline, "claude 60% $5/$10 50% $5/$10 extra");
    assert.equal(
      formatUsageStatusline(financialAnthropicReport, model("anthropic", "claude-sonnet", "Claude Sonnet")),
      financialAnthropicReport.statusline,
    );
    assert.equal(
      formatUsageStatusline(financialAnthropicReport, model("anthropic", "fable", "Claude Fable")),
      "Claude · Cinder Cove 60% · Fable 5h 75% ↻2h · Fable 7d 41% ↻5d · overage 50%",
    );
  } finally {
    Date.now = originalNow;
  }
});

void test("labels native Codex windows by reported duration for every model bucket", () => {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    assert.equal(
      formatUsageStatusline(nativeCodexReport, model("openai-codex", "gpt-5.6-sol", "GPT-5.6 Sol")),
      "Codex · 7d 88% ↻6d",
    );
    assert.equal(
      formatUsageStatusline(nativeCodexReport, model("openai-codex", "gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark")),
      "Codex spark · 5h 0% ↻4h · 7d 8% ↻6d",
    );
  } finally {
    Date.now = originalNow;
  }
});

void test("labels detailed native Codex windows by reported duration", () => {
  const report = formatCodexUsageReport(nativeCodexReport);
  assert.match(report, / {2}7d limit:\s+\[/);
  assert.match(report, / {2}GPT-5\.3-Codex-Spark limit:\n {2}5h limit:\s+\[/);
  assert.match(report, / {2}7d limit:\s+\[/g);
  assert.doesNotMatch(report, / {2}5h limit:\s+\[[^\n]+88% used/);
});

void test("renders matching external Codex model windows", () => {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    assert.equal(
      formatUsageStatusline(codexAdapterReport, model("openai-codex", "gpt-5.1-codex", "GPT 5.1 Codex")),
      "Codex · 5h 32% ↻47m · 7d 18% ↻5d",
    );
  } finally {
    Date.now = originalNow;
  }
});

void test("falls back to Anthropic account windows for an unmatched Claude model", () => {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    assert.equal(
      formatUsageStatusline(anthropicReport, model("anthropic", "claude-sonnet", "Claude Sonnet")),
      "Claude · 5h 23% ↻3h · 7d 12% ↻5d",
    );
  } finally {
    Date.now = originalNow;
  }
});

void test("does not render a report for an unsupported or different provider", () => {
  const unsupportedModel = model("google", "gemini-pro", "Gemini Pro");
  assert.equal(formatUsageStatusline(anthropicReport, unsupportedModel), undefined);
  assert.equal(formatUsageStatusline(codexAdapterReport, unsupportedModel), undefined);
  assert.equal(reportMatchesModel(codexAdapterReport, unsupportedModel), false);
});

test("formatUsageReport tags the Anthropic header with the injected account email", () => {
  const withEmail = formatUsageReport(anthropicReport, undefined, () => "court@subaud.io");
  const header = withEmail.split("\n").find((line) => line.includes(">_ Anthropic Usage"));
  assert.ok(header, "expected an Anthropic Usage header line");
  assert.match(header as string, /\(court@subaud\.io\)/);
});

test("formatUsageReport omits the account tag when no email resolves", () => {
  const withoutEmail = formatUsageReport(anthropicReport, undefined, () => undefined);
  const header = withoutEmail.split("\n").find((line) => line.includes(">_ Anthropic Usage"));
  assert.ok(header, "expected an Anthropic Usage header line");
  assert.doesNotMatch(header as string, /\(/);
});
