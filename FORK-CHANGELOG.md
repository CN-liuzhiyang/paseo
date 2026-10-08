# PaseoFork changelog

Releases of this fork, newest first. Each one names the upstream release it
carries; upstream's own notes for that version are in
[CHANGELOG.md](CHANGELOG.md).

The app's What's New sheet reads this file, so keep the shape it parses: `##`
starts a release, `###` starts a section, everything else is ordinary markdown.
The version must match the tag exactly — `fork-v1.0.2` is `## 1.0.2` — or the
sheet will not mark it as the one you are running.

## 1.3.0 - 2026-10-08

Carries upstream v0.11.1, up from v0.10.2. The full upstream notes are in
[CHANGELOG.md](CHANGELOG.md) under 0.10.3 through 0.11.1.

### Added

- Usage, opened from the sidebar footer, shows each subscription account's quota windows, with an opt-in summary of the windows you pin.
- Muse Code and Antigravity are available as providers.
- Claude Haiku 5.5 is available with Claude Code 2.1.293 or newer.
- A Content width setting limits the width of chat and Markdown files on wide screens, and Vue files are syntax highlighted.
- Plugins can add screens and sidebar header or footer items, usage sources, and run CLIs through `spawnProcess()` and `execCommand()`.

### Changed

- `paseo plugin add owner/slug` installs from the plugin registry. Use `github:owner/repo` to install straight from GitHub and `./path` for a local directory.
- Codex Fast is now a Speed menu listing the speeds each model offers, and Explorer tabs work like workspace tabs.
- Relative timestamps in agent, schedule, and Import session rows keep advancing while on screen.

### Fixed

- Claude tool calls that run longer than 30 seconds showing up as subagents, and subagents that finish while the app is disconnected staying "working".
- Claude agent history showing "No activity to display" after a daemon restart when its transcript is in another project folder.
- Rewinding a legacy Codex chat failing with `unknown variant thread/rollback` on Codex 0.156 and newer.

## 1.2.0 - 2026-09-30

Carries upstream v0.10.2, up from v0.9.1. The full upstream notes are in
[CHANGELOG.md](CHANGELOG.md) under 0.9.2 through 0.10.2.

### Added

- OpenCode v2 sessions work in Paseo; the installed OpenCode version selects the matching integration automatically.
- Pi task, subagent, and question extensions appear in the chat and Subagents track.
- Claude Sonnet 5.5 is available with Claude Code 2.1.284 or newer. Claude sessions can also pass structured launch arguments, such as `--chrome`.
- Add host and pairing flows accept a password for protected daemons, including remote connections.

### Improved

- Settings are organized into General, Sidebar, Chat, Terminal, Browser, and Open location pages.
- Add Project searches large directories faster, and the daemon spends less time polling repositories its watcher cannot observe.

### Fixed

- OpenCode v2 long turns, question answers, edit diffs, and context usage display.
- Daemon memory growth after clients disconnect, and watcher stalls caused by ignored directories.
- Workspaces on unavailable disks or network shares disappearing, and archived agent logs failing after their worktree is removed.
- Codex rewind dropping a custom provider and Paseo tools, and Default or Read-only mode sending approval requests to Auto-review.

## 1.1.2 - 2026-09-24

Carries upstream v0.9.1, the same base as 1.1.1.

### Added

- Schedules can deliver each run's result through a channel that a plugin registers, such as a chat service. Pick the destination by name under "Deliver results" in the schedule form, or pass `--deliver channel:to` to `paseo schedule create` and `update`. Failed runs are delivered too, with the error, so the recipient knows it did not work. Every run records whether delivery succeeded, and the schedule row shows where results go and how the last delivery went.
- Plugins register outbound channels with `server.registerChannel`, and can list their destinations so people choose them by name. `paseo schedule channels` shows what the connected daemon offers.

## 1.1.1 - 2026-09-23

Carries upstream v0.9.1, the same base as 1.1.0.

### Added

- Plugin server entries receive the Paseo API as `server.paseo`. Before this, a plugin could create or message agents only from inside a hook or an RPC handler. Now it can also do so when its own work starts, such as a message arriving from a chat service or a timer firing. Hooks and handlers still receive the API as `context.paseo`.

## 1.1.0 - 2026-09-23

Carries upstream v0.9.1, up from v0.9.0-beta.2. That is two upstream releases
at once and a big one — the full list is in [CHANGELOG.md](CHANGELOG.md) under
0.9.0 and 0.9.1.

### Added

- Cmd/Ctrl+F Find in file panes (with replace in editable files), in terminal scrollback, and in chat. Chat search reaches messages outside the loaded history window.
- Opus 5.5 in the Claude catalog as the default model, with a 1M context window and Fast Mode. Needs Claude Code 2.1.280 or newer.
- Plugins install from npm, and `paseo plugin update` shows the current and proposed revision before you approve it.
- The Pull request tab opens by itself, once per workspace, when a PR is detected.

### Improved

- Cold diff generation on a 213-file workspace: 11.45s to 2.65s.
- Desktop main-process memory after loading daemon management: 290.5 MiB to 152.1 MiB.
- Time to first voice audio on a three-sentence reply: 4.80s to 0.95s.

### Fixed

- The daemon exhausting its heap in long conversations with cumulative tool output.
- A crash loop after closing the last content tab in a workspace.
- Plugin build commands failing with `spawn npm ENOENT` on Windows.
- The sidebar keeping only recently changed conversations after the app reconnects to a daemon.

## 1.0.3 - 2026-09-22

Carries upstream v0.9.0-beta.2.

### Fixed

- What's New listed upstream's releases. It reads this file now. Upstream's notes are still in the repo, and every entry here names the upstream release it carries.

## 1.0.2 - 2026-09-22

Carries upstream v0.9.0-beta.2.

### Fixed

- The About screen and the daemon both reported 0.9.0-beta.2 on a 1.0.x install. Every workspace is stamped at build time now, not just the desktop package.

## 1.0.0 - 2026-09-22

Carries upstream v0.9.0-beta.2.

The first PaseoFork build. Same application as upstream, published from this
fork so that updates, and eventually fork-only features, come from here.

### Install notes

- The installer offers `AppData/Local/Programs/Paseo` by default, which is where the official app installs. **Change the folder** if you want to keep both.
- Windows builds are unsigned, so SmartScreen warns on first run. Upstream signs macOS only; a Windows certificate needs a hardware key.
