#!/usr/bin/env node
// Guards the two invariants that keep this fork mergeable with upstream.
//
//   1. Red line — nothing project-specific may reach `next`. Team-specific
//      behaviour belongs in a private plugin, never in core.
//   2. Budget — the delta stays small enough that a weekly sync is mechanical.
//      Crossing the budget is not a failure, it is a prompt to ask which
//      patches should have been plugins or upstream PRs by now.
//
//   node fork-tools/check-delta.mjs
//
// This fork is public, and so are its CI logs. forbidden-patterns.txt stays
// generic on purpose: internal hostnames and project names do not belong
// there, and must not be fed in through FORK_GUARD_EXTRA_PATTERNS either. That
// file's header explains why, and what catches them instead.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const MIRROR = process.env.FORK_GUARD_MIRROR ?? "main";
const WORK = process.env.FORK_GUARD_WORK ?? "HEAD";

const MAX_FILES = Number(process.env.FORK_GUARD_MAX_FILES ?? 40);
const MAX_LINES = Number(process.env.FORK_GUARD_MAX_LINES ?? 1000);

// Paths that exist only because this is a fork. They never go upstream and
// never sit where upstream edits, so they cost nothing at merge time and are
// not part of the budget. The red line still applies to them.
const FORK_OWN = [
  /^fork-tools\//,
  /^localdocs\//,
  /^\.github\/workflows\/fork-[^/]+\.yml$/,
  /^FORK-CHANGELOG\.md$/,
];
const isForkOwn = (file) => FORK_OWN.some((pattern) => pattern.test(file));

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

function patterns() {
  const file = new URL("./forbidden-patterns.txt", import.meta.url);
  const committed = existsSync(file) ? readFileSync(file, "utf8") : "";
  const extra = process.env.FORK_GUARD_EXTRA_PATTERNS ?? "";
  return [committed, extra]
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => new RegExp(line, "i"));
}

function addedLines() {
  const diff = git("diff", "--unified=0", `${MIRROR}...${WORK}`);
  const results = [];
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    else if (line.startsWith("+") && !line.startsWith("+++"))
      results.push({ file, text: line.slice(1) });
  }
  return results;
}

const IS_CI = Boolean(process.env.CI ?? process.env.GITHUB_ACTIONS);

let failed = false;

// --- Red line -------------------------------------------------------------
const rules = patterns();
const hits = [];
if (rules.length > 0) {
  for (const { file, text } of addedLines()) {
    const rule = rules.find((pattern) => pattern.test(text));
    if (rule) hits.push({ file, rule: rule.source, text: text.trim().slice(0, 120) });
  }
}

if (hits.length > 0) {
  failed = true;
  console.error(`RED LINE: ${hits.length} project-specific reference(s) in the fork delta.\n`);
  // CI logs on this repository are public. Naming the pattern that matched, or
  // echoing the line, would publish the thing the red line exists to keep out.
  // Report the file and let the author run this locally for the detail.
  if (IS_CI) {
    for (const file of new Set(hits.map((hit) => hit.file))) console.error(`  ${file}`);
    console.error("\nRun `node fork-tools/check-delta.mjs` locally to see which lines matched.");
  } else {
    for (const hit of hits) console.error(`  ${hit.file}\n    /${hit.rule}/  ${hit.text}`);
  }
  console.error(
    "\nThis belongs in a private plugin, not in core. See localdocs/fork-strategy.md.\n",
  );
} else {
  console.log(`Red line: clean (${rules.length} pattern${rules.length === 1 ? "" : "s"} checked).`);
}

// --- Budget ---------------------------------------------------------------
const stat = git("diff", "--numstat", `${MIRROR}...${WORK}`).split("\n").filter(Boolean);
let files = 0;
let lines = 0;
let ownFiles = 0;
for (const row of stat) {
  const [added, removed, file] = row.split("\t");
  if (added === "-") continue; // binary
  if (isForkOwn(file)) {
    ownFiles += 1;
    continue;
  }
  files += 1;
  lines += Number(added) + Number(removed);
}

const over = files > MAX_FILES || lines > MAX_LINES;
console.log(
  `Budget:    ${files}/${MAX_FILES} files, ${lines}/${MAX_LINES} lines${over ? "  OVER" : ""}` +
    (ownFiles > 0 ? `  (+${ownFiles} fork-own, not counted)` : ""),
);

if (over) {
  failed = true;
  console.error(`
The delta outgrew its budget. Before raising the limit, check each patch:

  git log --oneline ${MIRROR}..${WORK}

  - Landed upstream already?       revert the local copy
  - Could it be a plugin?          move it, shrink core to the extension point
  - Never submitted upstream?      open the PR from a branch off ${MIRROR}
`);
}

process.exit(failed ? 1 : 0);
