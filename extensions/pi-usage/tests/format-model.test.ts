import assert from "node:assert/strict";
import test from "node:test";
import { formatCodexUsageReport, formatUsageReport, formatUsageStatusline } from "../src/format.js";
import { reportMatchesModel } from "../src/models.js";
import { normalizeAnthropicUsagePayload } from "../src/normalize-anthropic.js";
import type { AdapterUsageReport, CodexUsageReport, NormalizedUsageWindow, ProviderUsageModel } from "../src/types.js";

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
      "Claude · Cinder Cove 60% · Fable 5h 75% ↻2h · Fable 7d 41% ↻5d · overage $5.00/$10.00 50%",
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

test("formatUsageReport never labels a native Claude report (Decision 3: labeling native reports is a follow-up)", () => {
  const text = formatUsageReport(anthropicReport);
  const header = text.split("\n").find((line) => line.includes(">_ Anthropic Usage"));
  assert.ok(header, "expected an Anthropic Usage header line");
  assert.doesNotMatch(header as string, /\(/);
});

// Decision 4: a consumption account's spend, from the `enterprise_fundamental`
// fixture (fixtures.json): used_credits 6944 / monthly_limit 500000, both /100
// (decimal_places 2) => $69.44 of $5,000; utilization 1.3888 => 1%; resetsAt
// 1793491200 (epoch seconds).
function spendAdapterReport(window: Partial<NormalizedUsageWindow> = {}): AdapterUsageReport {
  return {
    provider: "claude",
    source: "external-adapter",
    snapshotSource: "claude-code-usage-control",
    complete: true,
    modelProviders: ["claude-bridge"],
    capturedAt: now,
    windows: [
      {
        id: "extra_usage",
        label: "spend",
        scope: { kind: "overage" },
        usedPercent: 1.3888,
        usedAmount: 69.44,
        limitAmount: 5000,
        currency: "USD",
        resetsAt: 1793491200,
        ...window,
      },
    ],
  };
}

void test("formats a consumption account's spend window as money on the status line", () => {
  const originalNow = Date.now;
  Date.now = () => (1793491200 - 10 * 86_400) * 1000;
  try {
    assert.equal(
      formatUsageStatusline(spendAdapterReport(), model("claude-bridge", "claude-sonnet", "Claude Sonnet")),
      "Claude · spend $69.44/$5,000 1% ↻10d",
    );
  } finally {
    Date.now = originalNow;
  }
});

void test("a max account with credits active formats the same spend shape under the overage label", () => {
  assert.equal(
    formatUsageStatusline(
      spendAdapterReport({ label: "overage", usedAmount: 12.5, limitAmount: 100, resetsAt: undefined }),
      model("claude-bridge", "claude-sonnet", "Claude Sonnet"),
    ),
    "Claude · overage $12.50/$100.00 1%",
  );
});

void test("omits the limit, the percent, and the countdown on the status line when each is absent", () => {
  const noLimit = formatUsageStatusline(
    spendAdapterReport({ limitAmount: undefined }),
    model("claude-bridge", "claude-sonnet", "Claude Sonnet"),
  );
  assert.match(noLimit ?? "", /spend \$69\.44 1%/);
  assert.doesNotMatch(noLimit ?? "", /\//);

  const noPercent = formatUsageStatusline(
    spendAdapterReport({ usedPercent: undefined }),
    model("claude-bridge", "claude-sonnet", "Claude Sonnet"),
  );
  assert.equal(noPercent?.includes("spend $69.44/$5,000"), true);
  assert.doesNotMatch(noPercent ?? "", /%/);

  const noReset = formatUsageStatusline(
    spendAdapterReport({ resetsAt: undefined }),
    model("claude-bridge", "claude-sonnet", "Claude Sonnet"),
  );
  assert.doesNotMatch(noReset ?? "", /↻/);
});

void test("falls back to the plain label-and-percent form when no usedAmount is present", () => {
  assert.equal(
    formatUsageStatusline(
      spendAdapterReport({ usedAmount: undefined, limitAmount: undefined, resetsAt: undefined }),
      model("claude-bridge", "claude-sonnet", "Claude Sonnet"),
    ),
    "Claude · spend 1%",
  );
});

void test("falls back to a plain number when the currency is unknown, absent, or invalid", () => {
  const absent = formatUsageStatusline(
    spendAdapterReport({ currency: undefined }),
    model("claude-bridge", "claude-sonnet", "Claude Sonnet"),
  );
  assert.equal(absent?.includes("spend 69.44/5,000.00 1%"), true);

  const invalid = formatUsageStatusline(
    spendAdapterReport({ currency: "not-a-currency" }),
    model("claude-bridge", "claude-sonnet", "Claude Sonnet"),
  );
  assert.equal(invalid?.includes("spend 69.44/5,000.00 1%"), true);
});

void test("/usage renders the spend window as money with a combined amount-and-reset parenthetical", () => {
  const originalNow = Date.now;
  Date.now = () => (1793491200 - 10 * 86_400) * 1000;
  try {
    const text = formatUsageReport(spendAdapterReport());
    assert.match(text, />_ Claude Usage/);
    assert.match(text, /Spend usage:/);
    assert.match(text, /Spend:\s+.*1% used \(\$69\.44 of \$5,000\.00, resets /);
  } finally {
    Date.now = originalNow;
  }
});

void test("/usage uses the Overage group label and omits the limit/reset when absent", () => {
  const text = formatUsageReport(spendAdapterReport({ label: "overage", limitAmount: undefined, resetsAt: undefined }));
  assert.match(text, /Overage usage:/);
  assert.match(text, /Overage:\s+.*1% used \(\$69\.44\)/);
});

void test("the /usage header carries the account label when one is known", () => {
  const report: AdapterUsageReport = {
    ...spendAdapterReport(),
    account: { id: "c33cb52c", label: "fundamental@example.com" },
  };
  const text = formatUsageReport(report);
  assert.match(text, />_ Claude Usage \(fundamental@example\.com\)/);
});
