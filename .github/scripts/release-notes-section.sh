#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Shogo Technologies, Inc.
#
# Keep independent blocks in a GitHub Release body without any one publisher
# owning the whole body.
#
# Four workflows write to a `v*` release on the same tag. Each used to rewrite
# the notes wholesale (softprops `append_body`, `gh release edit --notes-file`),
# so whichever finished last won and the others' blocks disappeared — v2.6.7
# and v2.6.8 shipped without the runtime digest table. Every block now lives
# between markers, and every writer goes through this script:
#
#   <!-- shogo:section runtime-image -->
#   ### Standalone agent runtime image
#   ...
#   <!-- /shogo:section runtime-image -->
#
#   upsert <tag> <id> <file>            replace section <id> with <file>, or
#                                       append it when the body has none yet
#   rewrite <tag> <head-file> [--title <title>]
#                                       make <head-file> the top of the body and
#                                       keep every section below it unchanged
#
# Both modes re-read the body after writing and retry the whole
# read-modify-write when another publisher clobbered it in between (3 attempts,
# 15 s apart, RELEASE_NOTES_RETRY_* to override), so the two jobs can finish in
# either order.
#
# A body written before the markers existed (v2.6.5–v2.6.8: a bare
# `### Standalone agent runtime image` block) is understood as section
# `runtime-image` and is kept and wrapped on the next write.
#
# Dies on unknown args, missing files and unverifiable writes with ::error::.
set -euo pipefail

RETRY_ATTEMPTS="${RELEASE_NOTES_RETRY_ATTEMPTS:-3}"
RETRY_DELAY_SECONDS="${RELEASE_NOTES_RETRY_DELAY:-15}"

usage() {
  cat >&2 <<'EOF'
usage:
  release-notes-section.sh upsert <tag> <section-id> <file>
  release-notes-section.sh rewrite <tag> <head-file> [--title <title>]

env:
  GH_TOKEN / GITHUB_TOKEN   credential for gh
  GH_REPO                   owner/repo (gh infers it from the checkout otherwise)
  RELEASE_NOTES_RETRY_ATTEMPTS   default 3
  RELEASE_NOTES_RETRY_DELAY      seconds between attempts, default 15
EOF
  exit 2
}

release_missing=0

# Print the release body to $2, creating the release as a draft when the tag
# has no release yet (so finalize-release.yml still decides when it goes
# public, exactly like the softprops publishers do).
fetch_body() {
  local tag="$1" out="$2" err
  err="$(mktemp)"
  if gh release view "$tag" --json body -q .body >"$out" 2>"$err"; then
    release_missing=0
    rm -f "$err"
    return 0
  fi
  if grep -qiE 'not found|HTTP 404' "$err"; then
    echo "release $tag: no release yet, publishing this block creates it as a draft" >&2
    : >"$out"
    release_missing=1
    rm -f "$err"
    return 0
  fi
  echo "::error::release $tag: gh release view failed" >&2
  cat "$err" >&2
  rm -f "$err"
  return 1
}

publish_body() {
  local tag="$1" file="$2" title="$3"
  local args=(--notes-file "$file")
  if [ -n "$title" ]; then
    args+=(--title "$title")
  fi
  if [ "$release_missing" = "1" ]; then
    gh release create "$tag" --draft --title "${title:-$tag}" --notes-file "$file"
    release_missing=0
    return 0
  fi
  gh release edit "$tag" "${args[@]}"
}

# Body surgery in python3 (present on ubuntu-latest and macOS runners):
# identical block handling in both modes, and no BSD/GNU sed differences.
transform_body() {
  python3 - "$@" <<'PY'
import re
import sys

mode, key, section_file, body_in, body_out = sys.argv[1:6]

LEGACY_HEADINGS = {"runtime-image": "Standalone agent runtime image"}
MARKED = re.compile(
    r"<!-- shogo:section ([A-Za-z0-9._-]+) -->\n?(.*?)\n?<!-- /shogo:section \1 -->",
    re.S,
)


def clean(text):
    return text.strip("\n")


def block(sid, content):
    return (
        "<!-- shogo:section %s -->\n\n%s\n\n<!-- /shogo:section %s -->"
        % (sid, clean(content), sid)
    )


def legacy_span(lines, heading):
    """Heading line through the line before the next same-or-higher heading."""
    start = None
    for i, line in enumerate(lines):
        if line.strip() == "### " + heading:
            start = i
            break
    if start is None:
        return None
    depth = len(lines[start]) - len(lines[start].lstrip("#"))
    end = len(lines)
    for j in range(start + 1, len(lines)):
        stripped = lines[j].lstrip()
        if stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            if level <= depth:
                end = j
                break
    return start, end


def wrap_legacy(body):
    """Turn pre-marker sections into marked ones so both modes see one shape."""
    for sid, heading in LEGACY_HEADINGS.items():
        if "<!-- shogo:section %s -->" % sid in body:
            continue
        lines = body.split("\n")
        span = legacy_span(lines, heading)
        if span is None:
            continue
        start, end = span
        head = "\n".join(lines[:start]).rstrip("\n")
        tail = "\n".join(lines[end:]).lstrip("\n")
        wrapped = block(sid, "\n".join(lines[start:end]))
        body = head + "\n\n" + wrapped if head else wrapped
        if tail:
            body = body + "\n\n" + tail
    return body


def sections(body):
    return [(m.group(1), clean(m.group(2))) for m in MARKED.finditer(body)]


body = open(body_in).read()
if mode == "upsert":
    wanted = clean(open(section_file).read())
    body = wrap_legacy(body)
    replacement = block(key, wanted)
    seen = []

    def swap(match):
        if match.group(1) != key:
            return match.group(0)
        seen.append(match.group(1))
        return replacement

    body = MARKED.sub(swap, body)
    if not seen:
        body = (clean(body) + "\n\n" + replacement) if clean(body) else replacement
    out = clean(body) + "\n"
elif mode == "rewrite":
    head = clean(open(section_file).read())
    body = wrap_legacy(body)
    parts = [head] + [block(sid, content) for sid, content in sections(body)]
    out = clean("\n\n".join(parts)) + "\n"
else:
    sys.exit("unknown mode: " + mode)

with open(body_out, "w") as fh:
    fh.write(out)
PY
}

# Exit 0 only when the body we just wrote still holds our block and whatever
# the other publisher had put there before us.
verify_body() {
  python3 - "$@" <<'PY'
import re
import sys

mode, key, section_file, before_path, after_path = sys.argv[1:6]

MARKED = re.compile(
    r"<!-- shogo:section ([A-Za-z0-9._-]+) -->\n?(.*?)\n?<!-- /shogo:section \1 -->",
    re.S,
)


def clean(text):
    return text.strip("\n")


def sections(body):
    return [(m.group(1), clean(m.group(2))) for m in MARKED.finditer(body)]


before = open(before_path).read()
after = open(after_path).read()
after_sections = sections(after)

def single(sid):
    """The section's content, or None unless it appears exactly once."""
    hits = [content for got, content in after_sections if got == sid]
    return hits[0] if len(hits) == 1 else None


if mode == "upsert":
    found = single(key)
    wanted = clean(open(section_file).read())
    if found is None:
        print("section %s is missing (or duplicated) in the body we just wrote" % key)
        sys.exit(1)
    if found.strip() != wanted.strip():
        print("section %s does not hold the content we wrote" % key)
        sys.exit(1)
elif mode == "rewrite":
    head = clean(open(section_file).read())
    if not clean(after).startswith(head):
        print("the head we wrote is not at the top of the body")
        sys.exit(1)
    for sid, content in sections(before):
        found = single(sid)
        if found is None:
            print("section %s was dropped by another writer" % sid)
            sys.exit(1)
        if found.strip() != content.strip():
            print("section %s was changed by another writer" % sid)
            sys.exit(1)
else:
    sys.exit("unknown mode: " + mode)

sys.exit(0)
PY
}

mode="${1:-}"
case "$mode" in
  upsert)
    [ "$#" -eq 4 ] || usage
    tag="$2"
    section_id="$3"
    infile="$4"
    title=""
    ;;
  rewrite)
    [ "$#" -ge 3 ] || usage
    tag="$2"
    section_id=""
    infile="$3"
    title=""
    shift 3
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --title)
          [ "$#" -ge 2 ] || usage
          title="$2"
          shift 2
          ;;
        *)
          usage
          ;;
      esac
    done
    ;;
  *)
    usage
    ;;
esac

if [ ! -f "$infile" ]; then
  echo "::error::$mode: no such file: $infile" >&2
  exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

attempt=1
while :; do
  fetch_body "$tag" "$work/before.md"
  transform_body "$mode" "$section_id" "$infile" "$work/before.md" "$work/next.md"
  publish_body "$tag" "$work/next.md" "$title"
  fetch_body "$tag" "$work/after.md"

  if verify_body "$mode" "$section_id" "$infile" "$work/before.md" "$work/after.md"; then
    echo "release $tag: notes updated and verified (attempt $attempt)."
    exit 0
  fi

  if [ "$attempt" -ge "$RETRY_ATTEMPTS" ]; then
    echo "::error::release $tag: another publisher overwrote the notes $attempt times; the final body is wrong. Re-run this job." >&2
    exit 1
  fi
  echo "release $tag: another publisher overwrote the notes (attempt $attempt/$RETRY_ATTEMPTS); retrying in ${RETRY_DELAY_SECONDS}s." >&2
  attempt=$((attempt + 1))
  sleep "$RETRY_DELAY_SECONDS"
done
