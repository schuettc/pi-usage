#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * Bundle + minify a pi extension workspace package for npm publish.
 *
 * Reads src/index.ts, writes dist/index.js (single ESM file, comments stripped).
 * Pi host packages (@earendil-works/*) and native runtime dependencies stay
 * external; portable JavaScript dependencies like typebox are bundled in.
 *
 * Usage (from an extension folder): node ../../scripts/build-extension.mjs
 * Or via npm run build in each workspace package.
 */
import * as esbuild from "esbuild";

const pkgDir = process.cwd();
const entry = join(pkgDir, "src", "index.ts");
const outfile = join(pkgDir, "dist", "index.js");

mkdirSync(dirname(outfile), { recursive: true });

/** Provided by the pi host or installed beside an extension at runtime. */
const EXTERNAL_PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "fs-ext-extra-prebuilt",
  "playwright-core",
];

const result = await esbuild.build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  minify: true,
  format: "esm",
  platform: "node",
  target: "node22",
  legalComments: "none",
  treeShaking: true,
  external: EXTERNAL_PACKAGES,
  logLevel: "info",
});

if (result.errors.length > 0) {
  process.exit(1);
}

console.log(`Built ${outfile}`);
