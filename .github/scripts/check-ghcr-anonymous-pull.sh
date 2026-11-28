#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Shogo Technologies, Inc.
#
# Prove that a GHCR package can be pulled with no credentials — the thing
# `docs/STANDALONE_RUNTIME.md` promises partners and nothing checked.
#
# The package's visibility is an org setting no workflow can change, so every
# `v*` release asks the registry the same question an anonymous `docker pull`
# asks: mint an anonymous token from the public token endpoint and HEAD the
# manifest with it. Any non-200 means the package is private again and the
# release notes' pull line is a lie.
#
#   check-ghcr-anonymous-pull.sh ghcr.io/shogo-labs/shogo-runtime v2.6.8
#
# Env:
#   GHCR_BASE_URL   registry base, default https://ghcr.io (tests point it at a
#                   stub; the token endpoint is <base>/token)
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <registry>/<owner>/<package> <tag>" >&2
  exit 2
fi

image_ref="$1"
tag="$2"
base="${GHCR_BASE_URL:-https://ghcr.io}"
base="${base%/}"

# ghcr.io/shogo-labs/shogo-runtime -> shogo-labs/shogo-runtime
repo="${image_ref#*/}"
if [ "$repo" = "${image_ref}" ] || [ "$(printf '%s' "$repo" | tr -cd '/' | wc -c)" -ne 1 ]; then
  echo "::error::$0: expected <registry>/<owner>/<package>, got: $image_ref" >&2
  exit 2
fi
package="${repo#*/}"

hint="Packages -> ${package} -> Package settings -> Change visibility -> Public (org admin)."

fail() {
  echo "::error::GHCR package is not public: $1. ${hint}" >&2
  exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

token_url="${base}/token?service=ghcr.io&scope=repository:${repo}:pull"
# No Authorization header, no `docker login`, no GITHUB_TOKEN: this is the
# anonymous path a partner's `docker pull` takes.
token_status="$(curl -sS -o "$work/token.json" -w '%{http_code}' "$token_url" || true)"
if [ "$token_status" != "200" ]; then
  fail "the anonymous token request returned HTTP $token_status (${token_url})"
fi
token="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$work/token.json" | head -n 1)"
if [ -z "$token" ]; then
  fail "the anonymous token request returned no token (${token_url})"
fi

# An anonymous pull resolves the tag to an index / manifest list first (the tag
# is multi-arch), and a private package refuses exactly that request.
manifest_status="$(curl -sS -I -o /dev/null -D "$work/headers" -w '%{http_code}' \
  -H "Authorization: Bearer ${token}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
  "${base}/v2/${repo}/manifests/${tag}" || true)"
if [ "$manifest_status" != "200" ]; then
  fail "the anonymous manifest request for ${repo}:${tag} returned HTTP $manifest_status"
fi

digest="$(sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest:[[:space:]]*\(.*[^[:space:]]\).*/\1/p' "$work/headers" | head -n 1 | tr -d '\r')"
if [ -n "$digest" ]; then
  echo "anonymous pull OK: ${image_ref}:${tag} (${digest})"
else
  echo "anonymous pull OK: ${image_ref}:${tag}"
fi
