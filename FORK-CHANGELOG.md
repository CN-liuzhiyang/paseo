# PaseoFork changelog

Releases of this fork, newest first. Each one names the upstream release it
carries; upstream's own notes for that version are in
[CHANGELOG.md](CHANGELOG.md).

The app's What's New sheet reads this file, so keep the shape it parses: `##`
starts a release, `###` starts a section, everything else is ordinary markdown.
The version must match the tag exactly — `fork-v1.0.2` is `## 1.0.2` — or the
sheet will not mark it as the one you are running.

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
