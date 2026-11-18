#!/usr/bin/env bash
# Downloads the Fontshare (ITF Free Font License) webfonts this app self-hosts.
# The files are NOT committed: the FFL allows self-hosting on our own site but not redistributing the
# font files through a public repository, so each checkout fetches its own copy from Fontshare.
# Usage: scripts/fetch-fonts.sh <out-dir> slug@weight[i] ...
set -euo pipefail
OUT="$1"; shift; mkdir -p "$OUT"
for spec in "$@"; do
  slug="${spec%@*}"; w="${spec#*@}"
  file="$OUT/$slug-$w.woff2"
  [ -s "$file" ] && continue
  url=$(curl -fsS "https://api.fontshare.com/v2/css?f[]=${slug}@${w}&display=swap" | grep -oE "//cdn\.fontshare\.com/[^']+\.woff2" | head -1)
  [ -n "$url" ] || { echo "no woff2 for $spec" >&2; exit 1; }
  curl -fsS "https:$url" -o "$file"
  echo "fetched $file"
done
