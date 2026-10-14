#!/usr/bin/env node
// Writes a fork version into every workspace, the way a release build needs it.
//
//   node fork-tools/stamp-version.mjs 1.3.1
//
// The installer name and the updater comparison come from packages/desktop,
// the About screen reads packages/app, and the daemon and `paseo --version`
// report packages/server and packages/cli. Stamping only one of them leaves the
// rest claiming upstream's version: fork-v1.0.0 shipped as 1.0.0 and said
// 0.9.0-beta.2, and a hand-packed headless daemon reported 0.9.1 for months.
//
// This only edits package.json files. Release jobs run it on a throwaway
// checkout; on your own checkout, `git checkout -- .` afterwards.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
  console.error("Usage: node fork-tools/stamp-version.mjs <major.minor.patch>");
  process.exit(1);
}

const root = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(root, "utf8"));
pkg.version = version;
writeFileSync(root, `${JSON.stringify(pkg, null, 2)}\n`);

// Upstream's own script carries the root version to every workspace and pins
// the publishable ones' internal deps to it, so the packed tarballs resolve
// each other instead of reaching for the registry.
execFileSync(process.execPath, ["scripts/sync-workspace-versions.mjs"], {
  cwd: new URL("..", import.meta.url),
  stdio: "inherit",
});
