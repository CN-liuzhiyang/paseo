# Fork strategy

This fork exists because upstream has one maintainer and a deliberately narrow
intake. We need core capabilities sooner than that queue can deliver them. It
is a fast lane on the same road, not a different road.

Everything here follows from one property: **nothing in this fork is specific
to us.** The delta is generic product code that upstream could merge tomorrow.
That is what keeps a weekly sync mechanical instead of archaeological.

## Three layers

| Layer     | Holds                                  | Where                                     | Upstreamable |
| --------- | -------------------------------------- | ----------------------------------------- | ------------ |
| upstream  | getpaseo/paseo                         | read-only mirror                          | —            |
| this fork | core extension points, product-generic | `next`, public                            | all of it    |
| plugins   | everything specific to us              | separate repos; code public, data in none | never        |

## The red line

Project-specific behaviour never enters this fork. Not a hostname, not a team
name, not a workflow assumption, not a hard-coded config. It goes in a plugin.

The breach is always the same shape: the plugin API cannot do the thing, and
somebody is in a hurry. The answer to that is the next section, not a patch to
core.

Three things watch for it, and only one of them is a gate:

| Layer                             | Runs                    | Blocks?                                |
| --------------------------------- | ----------------------- | -------------------------------------- |
| `node fork-tools/check-delta.mjs` | When you run it         | No                                     |
| `pre-push` hook                   | Before your push leaves | Your push only; `--no-verify` skips it |
| `delta` required check on `next`  | On the PR, server side  | Yes — the PR cannot merge              |

The required check is the gate. The hook is fast feedback so you find out in
two seconds instead of two minutes, and a teammate who never sets it up is
still stopped by the check.

`forbidden-patterns.txt` stays generic — private IP ranges, `.corp`/`.internal`
hostname shapes, committed credentials. It will not recognise your own
hostnames, and it should not: this repository and its CI logs are public, and
the checker prints the pattern that matched, so a list of your internal names
would publish them the first time someone tripped it.

So the safety net catches shapes, and people catch the rest. The disposition
label on every PR is what makes that a decision someone has to make out loud
rather than one that gets skipped. Exactly one of `upstreamable`, `fork-only`,
`infra` or `sync`, enforced by the `classification` check. `sync` is separate
from `infra` because a sync PR carries no fork patch, so there is no
plugin-or-core call to make; everything else has one.

## The fork carries extension points, not features

When we need something Paseo cannot do:

1. Can a plugin do it? Write the plugin. The fork does not move.
2. Blocked by a missing extension point? Add the extension point here, in its
   generic form, and put the feature in the plugin.
3. Open the upstream PR for the extension point from a branch off `main`.

`packages/app/src/plugins/host-navigation.ts` is the worked example: the fork
added an `openCommitDiff` navigation API, and the behaviour that uses it lives
outside core.

Extension points are additive and sit on stable boundaries, so they cost
little at merge time. Features woven through core cost a lot, forever.

Before touching the SDK, read
[SDK import boundaries](../docs/plugins.md#sdk-import-boundaries). An SDK change
must also update the public reference, migration guide, scaffold, and examples —
upstream rejects PRs that skip this, and the compiler enforces the runtime
boundaries regardless.

## Branches

| Branch   | Rule                                                             |
| -------- | ---------------------------------------------------------------- |
| `main`   | Pure mirror of `upstream/main`. Fast-forward only. Never commit. |
| `next`   | Default branch. What we build and run. Never rewritten.          |
| `sync/*` | One upstream release merged into `next`. Opened as a PR.         |
| `pr/*`   | Branched off `main`. Upstream PRs only — no fork-local commits.  |

`git log main..next` is the delta inventory. Keep it readable.

Merges, not rebases, because `next` is shared: a merge commit records its
conflict resolution and the next merge reuses it. Rebase only `pr/*`, which
nobody else pulls.

## Local setup

Once per machine, per checkout:

```bash
git config rerere.enabled true    # replay conflict resolutions across sync steps
```

`lefthook-local.yml` is gitignored, so it does not exist in a fresh clone —
create it, then install the hook:

```yaml
# lefthook-local.yml
pre-push:
  jobs:
    - name: fork-delta
      run: node fork-tools/check-delta.mjs
```

```bash
npx lefthook install    # without this the pre-push script is never written
```

It goes in the local file rather than `lefthook.yml` because upstream owns
`lefthook.yml`, and a fork-only job there would conflict on every sync.

## Weekly sync

```bash
node fork-tools/sync-upstream.mjs
```

Reports which upstream releases `next` has not absorbed and what each one costs
in conflicts. It mutates nothing.

Take the oldest first. Conflicts are cheaper in steps, and `rerere` replays
each step's resolutions into the next. At the time of writing, stepping through
`v0.8.0-beta.1` (0 conflicts) and `v0.8.0` (1) costs less than jumping straight
to `v0.9.0-beta.1` (6).

```bash
node fork-tools/sync-upstream.mjs --to v0.8.0-beta.1
# resolve, then:
npm ci                     # only if package-lock.json moved, which it usually does
npm run build:server && npm run typecheck && npm run lint && npm run format
git checkout -- AGENTS.md packages/server/AGENTS.md   # Windows only; see README.md
node fork-tools/check-delta.mjs
git push origin main
git push -u origin sync/v0.8.0-beta.1
gh pr create --base next --title "sync: upstream v0.8.0-beta.1" --label sync
```

Skipping `npm ci` after the lockfile moves produces type errors that read like
real ones and are not.

When the plan lists several releases and every one of them costs zero
conflicts, merge them onto a single branch and open one PR. Stepping exists to
make conflicts cheaper, and there is nothing to make cheaper. Name the branch
after the newest tag, since that is what lands.

Once the PR is merged, `git pull` on `next` and cut a release from it —
[releases.md](releases.md#cutting-one). Absorbing upstream and shipping it are
one errand: nobody is running `next`.

Push `main` too. The script fast-forwards it locally, but the `delta` check on
the PR measures against `origin/main`, so a remote mirror left behind counts
everything the sync just absorbed as fork delta and fails on budget.

Never push `next` directly for a sync. A bad sync blocks everyone, and the
conflict resolutions are exactly what another pair of eyes is for.

That rule is about syncs and code, not about every commit. Release notes and
other markdown that ships nothing can go straight to `next` — a PR there buys a
`quality` run over a file no build reads, and the wait is the whole cost.

Syncing to release tags rather than `upstream/main` keeps the base shippable and
skips the lockfile and CI churn on upstream's tip.

## Upstreaming

Branch off `main` so the PR carries no fork-local commits:

```bash
git checkout -b pr/<name> main
git cherry-pick <sha>
gh pr create --repo getpaseo/paseo --base main
```

Upstream's bar is in [CONTRIBUTING.md](../CONTRIBUTING.md): one focused change,
the problem explained, QA evidence, tests, screenshots per platform, maintainer
edits enabled. PRs get closed; that is a stated outcome, not a failure. A closed
PR just means the patch stays in the delta.

When a patch does land upstream, remove our copy after the sync that brings it
back:

```bash
git revert <our sha>   # revert, not rebase — `next` is shared
```

## Plugins depend on fork-only APIs

A plugin using an extension point that exists only here will not run on a stock
Paseo build, and upstream may eventually land the same capability in a different
shape.

- Keep the fork-only SDK surface minimal. Every API is a future migration.
- Gate on capability, never on version. The daemon advertises
  `server_info.features.*`; check the flag once and run, with no fallback
  branch. `packages/app/src/git/use-diff-files.ts:74` is the pattern, and
  `packages/protocol/src/messages.ts:3412` is where the flag is declared.
- Tag every shim `// COMPAT(name): added in vX, remove after <date>`.
  `rg "COMPAT\("` is the cleanup backlog.
- A plugin cannot _require_ a fork build. `requirements.paseo` is a semver
  range, and semver ignores build metadata, so `0.9.0-beta.2+next.3` satisfies
  exactly what `0.9.0-beta.2` satisfies. Version fork builds that way anyway so
  humans can read what they are running, but the capability flag is the only
  thing that actually gates.

## When to revisit

The trigger is qualitative: **a sync whose conflicts require understanding why
upstream changed its design**, rather than mechanically re-aligning lines. That
means the fork has started to diverge in intent, not just in text.

At that point pick one, explicitly: shrink the delta back down, or accept a hard
fork and cherry-pick only upstream's security and bug fixes.

The delta budget in `check-delta.mjs` is the early warning, not the trigger.
