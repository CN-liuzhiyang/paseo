#!/usr/bin/env node
// Plans and executes an upstream sync for this fork.
//
// Without --to it only reports: which upstream releases are ahead of the
// mirror, and how many conflicts each one would cost. Nothing is mutated, so
// it is safe to run any time.
//
//   node fork-tools/sync-upstream.mjs
//   node fork-tools/sync-upstream.mjs --to v0.8.0
//
// Sync to the nearest release first. Conflicts are cheaper in two small steps
// than one large one, and rerere replays the first step's resolutions into the
// second.

import { execFileSync } from "node:child_process";

// `main` is a pure mirror of upstream/main and only ever fast-forwards. It is
// the base for upstream PRs and the reference for measuring the delta; it is
// not the sync target. Releases are merged into `next` one tag at a time.
const MIRROR = "main";
const WORK = "next";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const gitLines = (...args) =>
  git(...args)
    .split("\n")
    .filter(Boolean);

function conflictCount(from, to) {
  try {
    const out = execFileSync("git", ["merge-tree", "--write-tree", from, to], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\n").filter((line) => line.startsWith("CONFLICT")).length;
  } catch (error) {
    // merge-tree exits non-zero when the merge conflicts; the report is still
    // on stdout. Only a missing ref is a real failure.
    const out = error.stdout;
    if (typeof out !== "string") throw error;
    return out.split("\n").filter((line) => line.startsWith("CONFLICT")).length;
  }
}

function assertClean() {
  if (git("status", "--porcelain")) {
    throw new Error("Working tree is dirty. Commit or stash before syncing.");
  }
}

function candidates() {
  // Release tags only: the fork tracks releases, not upstream's main tip, so a
  // sync lands on a base upstream considered shippable.
  const tags = gitLines("tag", "--list", "v*", "--sort=creatordate", "--merged", "upstream/main");
  const have = new Set(gitLines("tag", "--list", "v*", "--merged", WORK));
  return tags.filter((tag) => !have.has(tag));
}

function plan() {
  const ahead = candidates();
  if (ahead.length === 0) {
    console.log(`${WORK} already carries the newest upstream release. Nothing to sync.`);
    return;
  }

  console.log(`Mirror  ${MIRROR}  ${git("log", "-1", "--format=%h %s", MIRROR)}`);
  console.log(
    `Work    ${WORK}   ${git("rev-list", "--count", `${MIRROR}..${WORK}`)} local commits\n`,
  );
  console.log(`Upstream releases ${WORK} has not absorbed, and what each costs:\n`);

  for (const tag of ahead) {
    const count = conflictCount(WORK, tag);
    const date = git("log", "-1", "--format=%ad", "--date=short", tag);
    console.log(`  ${tag.padEnd(18)} ${date}   ${count} conflict${count === 1 ? "" : "s"}`);
  }

  console.log(
    `\nSync to the oldest one first:\n  node fork-tools/sync-upstream.mjs --to ${ahead[0]}`,
  );
}

function execute(target) {
  assertClean();
  git("rev-parse", "--verify", `${target}^{commit}`);

  const branch = `sync/${target}`;
  console.log(`Fast-forwarding ${MIRROR} to upstream/main ...`);
  git("checkout", MIRROR);
  git("merge", "--ff-only", "upstream/main");

  console.log(`Creating ${branch} from ${WORK}, merging ${target} ...`);
  git("checkout", "-B", branch, WORK);

  let conflicted = [];
  try {
    execFileSync("git", ["merge", "--no-edit", target], { encoding: "utf8", stdio: "pipe" });
  } catch {
    conflicted = gitLines("diff", "--name-only", "--diff-filter=U");
  }

  if (conflicted.length === 0) {
    console.log("\nMerged clean.");
  } else {
    console.log(
      `\n${conflicted.length} file(s) conflict. Resolve, then \`git add\` and \`git commit\`:\n`,
    );
    for (const file of conflicted) console.log(`  ${file}`);
  }

  console.log(`
Then, before opening the sync PR:

  npm run build:server && npm run typecheck && npm run lint && npm run format
  node fork-tools/check-delta.mjs
  git push -u origin ${branch}
  gh pr create --base ${WORK} --title "sync: upstream ${target}"

Never push ${WORK} directly. A bad sync blocks everyone.`);
}

const args = process.argv.slice(2);
const toIndex = args.indexOf("--to");

console.log("Fetching upstream ...");
execFileSync("git", ["fetch", "upstream", "--tags", "--prune"], { stdio: "inherit" });
console.log("");

if (toIndex === -1) plan();
else execute(args[toIndex + 1]);
