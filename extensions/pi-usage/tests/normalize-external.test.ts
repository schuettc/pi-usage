import assert from "node:assert/strict";
import test from "node:test";
import { normalizeExternalUsageSnapshot } from "../src/normalize-external.js";
import type { ProviderUsageSnapshotV1 } from "../src/types.js";

const modelProviders = ["openai-codex"];

function snapshot(overrides: Partial<ProviderUsageSnapshotV1> = {}): ProviderUsageSnapshotV1 {
  return {
    version: 1,
    provider: "codex",
    source: "test-adapter",
    capturedAt: Date.parse("2026-09-12T13:00:00Z"),
    complete: true,
    windows: [
      {
        id: "gpt:five_hour",
        label: "5h",
        usedPercent: 32,
        resetsAt: Date.parse("2026-09-12T13:47:00Z") / 1000,
        windowMinutes: 300,
        scope: { kind: "model", modelIds: ["gpt-5.1"], label: "GPT Next" },
      },
    ],
    ...overrides,
  };
}

void test("rejects unsupported external snapshot versions", () => {
  assert.throws(
    () =>
      normalizeExternalUsageSnapshot(
        { ...snapshot(), version: 2 } as unknown as ProviderUsageSnapshotV1,
        modelProviders,
      ),
    /version/i,
  );
});

void test("rejects non-finite percentages and invalid reset values", () => {
  const nonFinitePercent = snapshot({
    windows: [{ ...snapshot().windows[0], usedPercent: Number.NaN }],
  });
  assert.throws(() => normalizeExternalUsageSnapshot(nonFinitePercent, modelProviders), /usedPercent/i);

  const invalidReset = snapshot({
    windows: [{ ...snapshot().windows[0], resetsAt: Number.POSITIVE_INFINITY }],
  });
  assert.throws(() => normalizeExternalUsageSnapshot(invalidReset, modelProviders), /resetsAt/i);
});

void test("rejects every malformed public snapshot and window field", () => {
  const cases: Array<[string, ProviderUsageSnapshotV1]> = [
    ["provider", { ...snapshot(), provider: "anthropic" } as never],
    ["providerLabel", { ...snapshot(), providerLabel: "" }],
    ["source", { ...snapshot(), source: 1 } as never],
    ["capturedAt", { ...snapshot(), capturedAt: -1 }],
    ["adapterId", { ...snapshot(), adapterId: "" }],
    ["complete", { ...snapshot(), complete: "yes" } as never],
    ["windows", { ...snapshot(), windows: {} } as never],
    ["scope", snapshot({ windows: [{ ...snapshot().windows[0], scope: { kind: "other" } as never }] })],
    [
      "modelIds",
      snapshot({
        windows: [{ ...snapshot().windows[0], scope: { kind: "model", modelIds: [1], label: "bad" } as never }],
      }),
    ],
    ["state", snapshot({ windows: [{ ...snapshot().windows[0], state: "bad" as never }] })],
    ["usedPercent", snapshot({ windows: [{ ...snapshot().windows[0], usedPercent: "25" as never }] })],
    ["usedAmount", snapshot({ windows: [{ ...snapshot().windows[0], usedAmount: Number.NaN }] })],
    ["limitAmount", snapshot({ windows: [{ ...snapshot().windows[0], limitAmount: -1 }] })],
    ["currency", snapshot({ windows: [{ ...snapshot().windows[0], currency: "" }] })],
  ];
  for (const [field, malformed] of cases) {
    assert.throws(() => normalizeExternalUsageSnapshot(malformed, modelProviders), new RegExp(field, "i"));
  }
});

void test("clamps percentages, accepts unknown model labels, and strips extra material", () => {
  const input = {
    ...snapshot(),
    authToken: "must-not-survive",
    windows: [
      { ...snapshot().windows[0], usedPercent: 140 },
      {
        id: "unknown",
        label: "A custom window",
        usedPercent: -12,
        scope: { kind: "model", modelIds: ["unknown-model"], label: "Nebula Ultra" },
        secret: "must-not-survive",
      },
    ],
  } as ProviderUsageSnapshotV1 & { authToken: string };

  assert.deepEqual(normalizeExternalUsageSnapshot(input, modelProviders), {
    provider: "codex",
    source: "external-adapter",
    snapshotSource: "test-adapter",
    complete: true,
    modelProviders: ["openai-codex"],
    capturedAt: Date.parse("2026-09-12T13:00:00Z"),
    windows: [
      {
        id: "gpt:five_hour",
        label: "5h",
        usedPercent: 100,
        resetsAt: Date.parse("2026-09-12T13:47:00Z") / 1000,
        windowMinutes: 300,
        scope: { kind: "model", modelIds: ["gpt-5.1"], label: "GPT Next" },
      },
      {
        id: "unknown",
        label: "A custom window",
        usedPercent: 0,
        scope: { kind: "model", modelIds: ["unknown-model"], label: "Nebula Ultra" },
      },
    ],
  });
});
