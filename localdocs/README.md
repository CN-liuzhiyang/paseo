# localdocs

Fork-only documentation. `docs/` belongs to upstream — writing here keeps our
notes out of every future merge conflict.

| Doc                                      | What's in it                                                        |
| ---------------------------------------- | ------------------------------------------------------------------- |
| [fork-strategy.md](fork-strategy.md)     | Why this fork exists, the red line, branches, the weekly sync       |
| [private-plugins.md](private-plugins.md) | Where our own behaviour lives, and how it depends on fork-only APIs |

Tooling lives in `fork-tools/`:

| Script                                         | Does                                             |
| ---------------------------------------------- | ------------------------------------------------ |
| `node fork-tools/sync-upstream.mjs`            | Plans a sync: which releases, how many conflicts |
| `node fork-tools/sync-upstream.mjs --to <tag>` | Executes one step                                |
| `node fork-tools/check-delta.mjs`              | Red line and delta budget                        |
