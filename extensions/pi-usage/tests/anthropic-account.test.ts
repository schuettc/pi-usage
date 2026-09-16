import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveAnthropicAccountEmail } from "../src/anthropic-account.js";

function withTempConfig(contents: string, run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-account-test-"));
  const path = join(directory, ".claude.json");
  writeFileSync(path, contents);
  try {
    run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

void test("returns the account email when oauthAccount.emailAddress is present", () => {
  withTempConfig(JSON.stringify({ oauthAccount: { emailAddress: "court@subaud.io" } }), (path) => {
    assert.equal(resolveAnthropicAccountEmail(path), "court@subaud.io");
  });
});

void test("returns undefined when the email is missing or blank", () => {
  withTempConfig(JSON.stringify({ oauthAccount: {} }), (path) => {
    assert.equal(resolveAnthropicAccountEmail(path), undefined);
  });
  withTempConfig(JSON.stringify({ oauthAccount: { emailAddress: "  " } }), (path) => {
    assert.equal(resolveAnthropicAccountEmail(path), undefined);
  });
});

void test("returns undefined for a malformed or missing config file", () => {
  withTempConfig("{ not valid json", (path) => {
    assert.equal(resolveAnthropicAccountEmail(path), undefined);
  });
  assert.equal(resolveAnthropicAccountEmail(join(tmpdir(), "pi-usage-does-not-exist-xyz.json")), undefined);
});
