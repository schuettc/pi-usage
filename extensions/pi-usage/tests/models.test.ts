import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicAuthCandidateModels,
  isAnthropicModel,
  providerKeyForModel,
  reportMatchesModel,
} from "../src/models.js";
import type { AnthropicUsageReport } from "../src/types.js";

const claudeBridgeModel = { provider: "claude-bridge", id: "claude-sonnet-4-5", name: "Claude Sonnet" };

const nativeClaudeReport: AnthropicUsageReport = {
  provider: "claude",
  source: "anthropic-oauth",
  capturedAt: 0,
  windows: [],
  summaryLines: [],
  statusline: "",
};

void test("claude-bridge is treated as an Anthropic-backed model", () => {
  assert.equal(isAnthropicModel(claudeBridgeModel), true);
  assert.equal(providerKeyForModel(claudeBridgeModel), "claude");
});

void test("a native claude OAuth report matches a claude-bridge model", () => {
  assert.equal(reportMatchesModel(nativeClaudeReport, claudeBridgeModel), true);
});

void test("anthropic auth candidates include claude-bridge models in a bridge-only session", () => {
  const ctx = {
    model: claudeBridgeModel,
    modelRegistry: { getAvailable: () => [claudeBridgeModel] },
  } as unknown as Parameters<typeof anthropicAuthCandidateModels>[0];
  const candidates = anthropicAuthCandidateModels(ctx);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.provider, "claude-bridge");
});
