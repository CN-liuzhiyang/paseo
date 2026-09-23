# localdocs

Fork-only documentation. `docs/` belongs to upstream — writing here keeps our
notes out of every future merge conflict.

This index is loaded into every agent session: the top of `CLAUDE.md` imports it
with `@localdocs/README.md`, and `AGENTS.md` is a symlink to `CLAUDE.md`, so
Codex and the other providers get it too. That block stays short on purpose.
Put the detail in the pages below, not in `CLAUDE.md`.

On Windows those symlinks are checked out as ordinary text files, so
`npm run format` rewrites them and stages a bogus one-line diff. Check
`git status` after formatting and `git checkout -- AGENTS.md
packages/server/AGENTS.md` if they show up.

| Doc                                  | What's in it                                                        |
| ------------------------------------ | ------------------------------------------------------------------- |
| [fork-strategy.md](fork-strategy.md) | Why this fork exists, the red line, branches, the weekly sync       |
| [plugins.md](plugins.md)             | Where our own behaviour lives, and how it depends on fork-only APIs |
| [releases.md](releases.md)           | What this fork publishes, tags, versions, and what stays upstream's |

Tooling lives in `fork-tools/`:

| Script                                         | Does                                             |
| ---------------------------------------------- | ------------------------------------------------ |
| `node fork-tools/sync-upstream.mjs`            | Plans a sync: which releases, how many conflicts |
| `node fork-tools/sync-upstream.mjs --to <tag>` | Executes one step                                |
| `node fork-tools/check-delta.mjs`              | Red line and delta budget                        |
