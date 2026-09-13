#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.cwd());
const workspace = "@schuettc/pi-usage";
const temporary = mkdtempSync(join(tmpdir(), "pi-usage-pack-smoke-"));

function npm(args, cwd = root) {
  return execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function pack(args) {
  const output = npm(["pack", "--workspace", workspace, "--json", "--ignore-scripts", ...args]);
  const result = JSON.parse(output);
  if (!Array.isArray(result) || result.length !== 1) throw new Error("npm pack did not describe exactly one package.");
  return result[0];
}

try {
  const dryRun = pack(["--dry-run"]);
  const paths = dryRun.files.map(({ path }) => path).sort();
  const expected = ["LICENSE", "README.md", "dist/index.js", "package.json"];
  if (JSON.stringify(paths) !== JSON.stringify(expected)) {
    throw new Error(`unexpected public package files: ${paths.join(", ")}`);
  }

  const packed = pack(["--pack-destination", temporary]);
  const tarball = join(temporary, packed.filename);
  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  writeFileSync(
    join(temporary, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          [workspace]: `file:${tarball}`,
          "@earendil-works/pi-coding-agent": rootPackage.devDependencies["@earendil-works/pi-coding-agent"],
          "@earendil-works/pi-tui": rootPackage.devDependencies["@earendil-works/pi-tui"],
        },
      },
      null,
      2,
    )}\n`,
  );
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], temporary);
  const extension = await import(pathToFileURL(join(temporary, "node_modules/@schuettc/pi-usage/dist/index.js")).href);
  if (typeof extension.default !== "function") throw new Error("packed pi-usage extension did not export a factory.");
  console.log("pi-usage packed artifact smoke test passed");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
