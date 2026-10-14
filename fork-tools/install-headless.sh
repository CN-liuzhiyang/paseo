#!/usr/bin/env bash
# Installs a fork release on a headless host, in place of
# `npm install -g @getpaseo/cli`. Linux and macOS.
#
#   install-headless.sh fork-v1.3.1
#
# The release workflow attaches the seven @getpaseo/* packages to every fork
# release. This downloads them into $PASEO_PACKS_DIR/<tag> (default
# ~/.paseo/packs) and installs them with a single `npm install -g`: installed
# together they resolve each other, so nothing @getpaseo comes from the
# registry. Third-party dependencies still do, so set the usual proxy
# variables first if the host needs them.
#
# Downloads are kept, and rolling back is installing an older tag. The daemon is
# not restarted: how it runs (systemd, launchd, a terminal) is the host's call.
#
# Do not press the app's "Update daemon" on a host installed this way. It runs
# `npm install -g @getpaseo/cli@latest`, which replaces this fork with upstream.
set -euo pipefail

tag="${1:-}"
version="${tag#fork-v}"
if [[ -z "$tag" || "$version" == "$tag" || ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: $0 fork-v<major.minor.patch>" >&2
  exit 1
fi

repo="${PASEO_FORK_REPO:-CN-liuzhiyang/paseo}"
dir="${PASEO_PACKS_DIR:-$HOME/.paseo/packs}/$tag"
mkdir -p "$dir"

# Same seven packages the release workflow packs.
for ws in highlight relay protocol client plugin server cli; do
  file="getpaseo-$ws-$version.tgz"
  if [[ -s "$dir/$file" ]]; then
    continue
  fi
  echo "Downloading $file"
  curl -fsSL --retry 3 -o "$dir/$file.part" \
    "https://github.com/$repo/releases/download/$tag/$file"
  mv "$dir/$file.part" "$dir/$file"
done

npm install -g "$dir"/getpaseo-*-"$version".tgz

installed="$(paseo --version)"
if [[ "$installed" != "$version" ]]; then
  echo "Installed packages, but paseo --version says $installed, not $version." >&2
  exit 1
fi
echo "Installed $tag. Restart the daemon to run it."
