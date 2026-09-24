# Plugins

Everything specific to us lives in a plugin, outside this fork. The code is
public wherever it can be; the data never enters a repository. Allowlists,
routes, credentials, hostnames and internal URLs go in per-host plugin settings
(`defineSettings`) or local config, and every table that grants access ships
empty. A plugin that only makes sense inside a company network -- one that
depends on internal tools -- lives in that company's own repository instead.

Plugins never enter this fork — see [fork-strategy.md](fork-strategy.md).

## Starting one

Use the real scaffold; do not hand-roll the layout.

```bash
npm run cli -- plugin init /absolute/path/to/our-plugin
```

It writes `paseo-plugin.json`, the `index.client.tsx` / `index.server.ts`
entries, and the `client/` `server/` `shared/` split the compiler enforces. The
[public reference](../public-docs/plugins/reference.md) is the API doc;
this page only covers what is different because we run a fork.

**On a fork build the scaffold does not install as written.** It pins
`@getpaseo/plugin` to the CLI's own version, which here is the fork's release
number, and npm has no such package:
`npm error notarget No matching version found for @getpaseo/plugin@1.0.3`.
Pin it to the version in this checkout's `packages/plugin/package.json` — the
upstream release the fork is based on, which npm does have. Link the fork's
SDK instead only when the plugin needs a fork-only API. `requirements.paseo` is
different: it is compared with the version the daemon reports, so there it is
the fork's number.

One repository per plugin, or one monorepo — either works. What matters is that
it is separate from this fork, and that nothing in it is data.

## Depending on a fork-only API

A plugin may use an extension point that exists here and not upstream. It must
degrade on a daemon that lacks it, because teammates run mixed versions during
a rollout and upstream may ship its own shape later.

Gate on the capability flag. Not on a version string: `requirements.paseo` is a
semver range and semver ignores build metadata, so a `+next.N` fork build
matches exactly what the upstream release it is based on matches.

```ts
// COMPAT(commitFiles): fork-only until upstream lands its own shape.
const hasCommitFiles = useDaemonStore(
  (state) =>
    state.sessions[serverId]?.serverInfo?.features?.commitFiles === true
);

if (!hasCommitFiles) {
  // Tell the user to update the host. No fallback path, no second code path
  // to keep working.
  return <UpdateRequired capability="commit diff" />;
}
```

The flag is declared in `packages/protocol/src/messages.ts:3412` and read in
`packages/app/src/git/use-diff-files.ts:74`. Adding an extension point to the
fork means adding its flag there too, or plugins have nothing to gate on.

Check the flag once, at the edge. A gate threaded through every call site is
the fallback path this rule exists to prevent.

An extension point on the server context needs no flag: server code runs
inside the daemon it would ask, so the member being present is the capability.
`server.paseo` is the example. Check `if (!server.paseo)` once in the entry,
log what the host is missing, and contribute nothing. `server.registerChannel`
works the same way: a channel plugin checks it once and contributes no channel
on a host without it.

## When upstream lands the same capability

Upstream will not necessarily match our API. When a sync brings back its
version:

1. Move the plugin to the upstream API.
2. Revert our extension point on `next`.
3. Drop the capability gate once every daemon in use has the upstream release.

The `COMPAT(...)` tag is what makes step 3 findable. `rg "COMPAT\("` across the
fork and the plugin repos is the cleanup backlog.

## Distribution

Teammates need two things: a fork build, and the plugins. Build the fork like
any Paseo release ([docs/release.md](../docs/release.md),
[docs/docker.md](../docs/docker.md)) and version it `<upstream>+next.N` so the
build a teammate is running is legible from the version string alone.
