import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicAuthCandidateModels,
  isAnthropicModel,
  providerKeyForModel,
  reportMatchesModel,
} from "../src/models.js";
import type { AdapterUsageReport, AnthropicUsageReport } from "../src/types.js";

const claudeBridgeModel = { provider: "claude-bridge", id: "claude-sonnet-4-5", name: "Claude Sonnet" };
const anthropicModel = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" };

const nativeClaudeReport: AnthropicUsageReport = {
  provider: "claude",
  source: "anthropic-oauth",
  capturedAt: 0,
  windows: [],
  summaryLines: [],
  statusline: "",
};

const externalClaudeBridgeReport: AdapterUsageReport = {
  provider: "claude",
  source: "external-adapter",
  snapshotSource: "test-adapter",
  complete: true,
  modelProviders: ["claude-bridge"],
  capturedAt: 0,
  windows: [{ id: "five_hour", label: "5h", usedPercent: 10, scope: { kind: "account" } }],
};

void test("claude-bridge is NOT treated as an Anthropic-backed model", () => {
  assert.equal(isAnthropicModel(claudeBridgeModel), false);
});

void test("a genuine anthropic model is treated as Anthropic-backed", () => {
  assert.equal(isAnthropicModel(anthropicModel), true);
  assert.equal(providerKeyForModel(anthropicModel), "claude");
});

void test("a native claude OAuth report does NOT match a claude-bridge model", () => {
  assert.equal(reportMatchesModel(nativeClaudeReport, claudeBridgeModel), false);
});

void test("an external-adapter claude report matches a claude-bridge model", () => {
  assert.equal(reportMatchesModel(externalClaudeBridgeReport, claudeBridgeModel), true);
});

void test("anthropic auth candidates do NOT include claude-bridge models", () => {
  const ctx = {
    model: claudeBridgeModel,
    modelRegistry: { getAvailable: () => [claudeBridgeModel] },
  } as unknown as Parameters<typeof anthropicAuthCandidateModels>[0];
  const candidates = anthropicAuthCandidateModels(ctx);
  assert.equal(candidates.length, 0);
});
