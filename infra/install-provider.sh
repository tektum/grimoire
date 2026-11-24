#!/usr/bin/env bash
# Installs the Descope provider plugin of SST (Pulumi) from a release asset whose sha256 this repository holds (infra/provider-checksums.txt), before any credential
# exists in the job. Pulumi would otherwise download the plugin on first use, with no checksum, inside the step that holds the cloud role and the Descope token.
# `--reinstall` replaces a copy that is already there (one fetched without a check). Needs `sst install` to have run first (it puts the pulumi binary where this script looks). A changed or replaced release asset fails the check and nothing is installed.
# To update: change the version in sst.config.ts, download the new linux-amd64 asset, and put its sha256 and file name in provider-checksums.txt.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
# SST runs Pulumi with its own folder as home (plugins in ~/.config/sst/plugins), so the plugin is installed there: any other home would leave SST to download an unchecked copy later.
export PULUMI_HOME="${PULUMI_HOME:-$HOME/.config/sst}"
pulumi="${PULUMI:-$PULUMI_HOME/bin/pulumi}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

while read -r sum file; do
  version="${file#pulumi-resource-descope-v}"
  version="${version%%-linux-amd64.tar.gz}"
  curl -fsSL --retry 3 --output "$work/$file" "https://github.com/descope/pulumi-descope/releases/download/v$version/$file"
  (cd "$work" && printf '%s  %s\n' "$sum" "$file" | sha256sum -c -)
  "$pulumi" plugin install resource descope "$version" --reinstall --server github://api.github.com/descope --file "$work/$file"
done < "$here/provider-checksums.txt"
