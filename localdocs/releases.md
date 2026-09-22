# Releases

This fork ships its own Windows desktop builds. Everything else — the relay,
`app.paseo.sh`, the npm packages — stays upstream's.

## What is ours, what is borrowed

| Surface               | Source                     | How                                                  |
| --------------------- | -------------------------- | ---------------------------------------------------- |
| Desktop app + updates | This repo's releases       | `.github/workflows/fork-release.yml`                 |
| In-app changelog      | This repo's `CHANGELOG.md` | `EXPO_PUBLIC_PASEO_SOURCE_REPO`                      |
| Relay                 | Official `relay.paseo.sh`  | unchanged; it is E2E encrypted and sees no plaintext |
| Pairing links         | Official `app.paseo.sh`    | unchanged                                            |
| npm `@getpaseo/*`     | Official                   | we publish nothing                                   |

We publish no npm packages. The desktop app bundles its own daemon, so a
teammate who installs the app needs nothing from a registry. If headless
installs ever matter, the cheapest option is an internal registry serving the
same `@getpaseo/*` names — no source change, and the daemon's own
`npm install -g @getpaseo/cli@latest` keeps working. The registry URL is
internal, so it goes in a private plugin or internal runbook, never here.

## Versions and tags

Fork releases are tagged `fork-v<semver>` and use an independent version line
of plain stable semver: `fork-v1.0.0`, `fork-v1.1.0`, `fork-v1.1.1`.

The tag prefix is not cosmetic. `v*` would break three things at once: it
collides with the upstream tags `main` mirrors, `sync-upstream.mjs` scans `v*`
to find upstream releases, and upstream's `desktop-release.yml` triggers on
`v*` and would publish a build pointing at upstream's update feed.

The version deliberately does not encode the upstream release it carries.
electron-updater routes anything with a prerelease suffix to its beta channel,
which this fork does not operate — a version like `0.9.0-beta.2.f.1` would be
built and then never offered to anyone. Put the upstream base in the release
notes instead.

Nothing is committed to cut a release. The workflow stamps the version into
`packages/desktop/package.json` at build time from the tag, so no `package.json`
in this repo ever diverges from upstream's version fields.

## Cutting one

```bash
git tag fork-v1.0.0 && git push origin fork-v1.0.0
```

Then write the release notes, naming the upstream release this build carries.

electron-builder publishes the installer and `latest.yml` itself. That manifest
is what existing installs poll, so a release without it ships to nobody.

## What a fork tag does not do

No npm publish, no macOS or Linux build, no rollout staging. macOS is not a
matter of adding a job: electron-updater verifies the code signature, so
auto-update there needs an Apple Developer certificate. Windows auto-updates
unsigned; the only cost is a SmartScreen prompt on first install.

## Identity

The build overrides `appId` and `productName` so it installs beside the
official app instead of replacing it. Both register the `paseo://` scheme —
whichever installed last wins deep links.

## The web app is still upstream's

A teammate can open `app.paseo.sh` against a daemon from this fork, and that
client is built from upstream. It will not have any fork-only feature. This is
the concrete reason for the capability rule in
[fork-strategy.md](fork-strategy.md): gate on `server_info.features.*` and the
upstream client degrades cleanly instead of breaking.
