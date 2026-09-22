# PaseoFork changelog

Releases of this fork, newest first. Each one names the upstream release it
carries; upstream's own notes for that version are in
[CHANGELOG.md](CHANGELOG.md).

The app's What's New sheet reads this file, so keep the shape it parses: `##`
starts a release, `###` starts a section, everything else is ordinary markdown.
The version must match the tag exactly — `fork-v1.0.2` is `## 1.0.2` — or the
sheet will not mark it as the one you are running.

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
