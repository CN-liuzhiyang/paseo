# Releases

This fork ships its own Windows desktop builds. Everything else — the relay,
`app.paseo.sh`, the npm packages — stays upstream's.

## What is ours, what is borrowed

| Surface               | Source                          | How                                                  |
| --------------------- | ------------------------------- | ---------------------------------------------------- |
| Desktop app + updates | This repo's releases            | `.github/workflows/fork-release.yml`                 |
| In-app changelog      | This repo's `FORK-CHANGELOG.md` | `EXPO_PUBLIC_PASEO_CHANGELOG_URL`                    |
| Relay                 | Official `relay.paseo.sh`       | unchanged; it is E2E encrypted and sees no plaintext |
| Pairing links         | Official `app.paseo.sh`         | unchanged                                            |
| npm `@getpaseo/*`     | Official                        | we publish nothing                                   |

We publish no npm packages. The desktop app bundles its own daemon, so a
teammate who installs the app needs nothing from a registry. If headless
installs ever matter, the cheapest option is an internal registry serving the
same `@getpaseo/*` names — no source change, and the daemon's own
`npm install -g @getpaseo/cli@latest` keeps working. The registry URL is
internal, so it goes in a private plugin or internal runbook, never here.

## Versions and tags

Fork releases are tagged `fork-v<semver>` and use an independent version line
of plain stable semver: `fork-v1.0.0`, `fork-v1.1.0`, `fork-v1.1.1`.

The prefix exists for one reason. Five upstream workflows trigger on `v*`
(desktop-release, android-apk-release, deploy-app, docker, release-notes-sync),
and `next` carries all of their files, so any `v`-shaped tag pushed here fires
every one of them. `fork-v*` matches none. The alternative — a `v1.0.1-fork.1`
version plus disabling those five in the Actions UI — works too, but a disabled
workflow cannot be dispatched, which would close the door on ever running
upstream's mac/Linux pipeline by hand.

Two things the prefix is not for, both of which look like reasons and are not.
Upstream tags cannot collide with a `-fork.N` version, and `sync-upstream.mjs`
already ignores fork tags because `candidates()` filters on
`--merged upstream/main`.

The version stays plain semver, with no fork suffix. A suffixed version does
work — electron-updater's stable path resolves through GitHub's
`/releases/latest`, which filters on the release's prerelease _flag_, not on the
version string — but only for as long as every release is published with
`releaseType=release`. Plain semver removes that standing dependency. The
upstream release a build carries is named in its `FORK-CHANGELOG.md` entry
instead.

Nothing is committed to cut a release. The workflow writes the tag's version
into the root `package.json` and runs `scripts/sync-workspace-versions.mjs`,
so no `package.json` in this repo ever diverges from upstream's version
fields. Stamping only `packages/desktop` is not enough: the installer name
and the updater comparison come from there, but the About screen reads
`packages/app/package.json` at bundle time and the daemon reports
`packages/server`. fork-v1.0.0 shipped as 1.0.0 and said 0.9.0-beta.2.

## Cutting one

Write the entry in `FORK-CHANGELOG.md`, push it straight to `next`, then tag:

```bash
git push origin next
git tag fork-v1.0.0 && git push origin fork-v1.0.0
```

The tag has to land on a commit that already carries the entry, so the push
comes first. Markdown goes to `next` without a PR — see
[fork-strategy.md](fork-strategy.md#weekly-sync).

The workflow creates a draft release, builds, uploads the installers, stamps and
validates `latest.yml`, then flips the draft to published.

`latest.yml` is what existing installs poll. A release without it ships to
nobody, which is why the workflow validates the file instead of trusting the
build to have produced it.

## The changelog

What's New reads `FORK-CHANGELOG.md` from `next`, not `CHANGELOG.md`. Same
parser, separate file: `CHANGELOG.md` is rewritten by upstream on every release
and is the one file guaranteed to conflict, so fork entries there would cost a
merge resolution every sync and gain nothing.

The upstream notes are still one link away — `CHANGELOG.md` is right there in
the repo, unmodified. A fork entry names the upstream release it carries and
lets the reader follow it.

Two things the sheet cares about. The version heading must match the tag
(`fork-v1.0.2` → `## 1.0.2`) or the release is not marked as the one running.
And the URL points at the `next` branch, not at the tag being built: the sheet
refetches on every open so that a build from months ago still shows what
shipped since.

`packages/app/src/constants/source-repo.ts` holds the default. It is a
fork-authored file that upstream does not have, so the knob costs no conflict
surface.

## The workflow is glue, on purpose

`fork-release.yml` calls `scripts/github-release.mjs`,
`scripts/upload-release-assets.mjs`, `scripts/stamp-rollout.mjs` and
`scripts/validate-desktop-manifests.mjs`, and builds with
`npm run build:desktop`. All of those are upstream's.

Keep it that way. The first version of this workflow used
`electron-builder --publish always` instead, which looked simpler and silently
dropped three things: the per-file upload retry that exists because
uploads.github.com returns 500 on installer-sized assets, the manifest
validation, and the rollout stamp. Fork-specific values belong in `-c.`
overrides and env vars; logic belongs in upstream's scripts.

## What a fork tag does not do

No npm publish, no macOS or Linux build. Rollout staging is wired up but
defaults to 0 hours, which admits everyone at once; raise `rollout_hours` on a
dispatch run to stage one. macOS is not a matter of adding a job: electron-updater verifies the code signature, so
auto-update there needs an Apple Developer certificate. Windows auto-updates
unsigned; the only cost is a SmartScreen prompt on first install.

## Identity

The build overrides `appId` and `productName` to `PaseoFork`. That gives it
its own user data directory, Start Menu entry and updater registry key, so it
is a separate application from the official app in every way but one: the
default install directory.

The installer still offers `AppData/Local/Programs/Paseo`, on top of the
official app. **Change the folder during install.**
`allowToChangeInstallationDirectory` is already true, so the directory page
is there.

That default is not configurable. NSIS takes it from `appInfo.productFilename`,
which is `executableName` when set, and upstream pins `executableName: Paseo`.
No nsis option moves it.

Overriding `executableName` does move it, and is a dead end. The same name
also names the packaged binary, and `packages/desktop/bin/paseo.cmd` hardcodes
`Paseo.exe`. That shim is how the desktop app cold-starts its own daemon, so
renaming breaks the app, not just a test — fork-v1.0.1 failed exactly there.
The POSIX shim hardcodes three more (`Paseo Helper.app`, `Paseo.bin`,
`Paseo`), drawn from `productName` and `executableName` in different places.

If the manual step ever becomes a problem, the untried option is an
`nsis.include` script that rewrites `$INSTDIR` in `customInit`. That macro
runs after `initMultiUser`, so a previous install's recorded path and a `/D`
override can both be left alone.

Both apps register the `paseo://` scheme — whichever installed last wins deep
links.

## The web app is still upstream's

A teammate can open `app.paseo.sh` against a daemon from this fork, and that
client is built from upstream. It will not have any fork-only feature. This is
the concrete reason for the capability rule in
[fork-strategy.md](fork-strategy.md): gate on `server_info.features.*` and the
upstream client degrades cleanly instead of breaking.
