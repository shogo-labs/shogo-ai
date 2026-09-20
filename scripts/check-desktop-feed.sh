#!/usr/bin/env bash
# Smoke test for the desktop beta update feed — the `/desktop/<channel>/...`
# route on the `releases.shogo.ai` Cloudflare Worker (see
# terraform/modules/install-shogo-ai/scripts/releases-worker.js.tftpl).
#
# Run this after a Terraform apply that touches that Worker, or ad hoc to
# sanity-check the deployed feed. It only hits the live worker + GitHub API
# (read-only) — no credentials or k8s context required.
#
# Checks (see the "Desktop beta update channel" plan, Layer 3):
#   1. GET /desktop/beta/darwin-arm64/0.0.1        -> 200 JSON, {url} points
#      at a Shogo-darwin-arm64-*.zip asset (0.0.1 is older than anything
#      that will ever be tagged/published, so an update must be offered).
#   2. GET /desktop/beta/darwin-arm64/99.0.0        -> 204 (nothing is ever
#      newer than 99.0.0, so the feed must report "up to date").
#   3. GET /desktop/beta/win32-x64/0.0.1/RELEASES   -> text body containing
#      an absolute (http/https) URL to a .nupkg — Squirrel.Windows refuses
#      relative nupkg URLs.
#   4. Parity: /desktop/stable/<platform>/<v> must agree with
#      update.electronjs.org/shogo-labs/shogo-ai/<platform>/<v> on both HTTP
#      status and (when 200) the offered release name — stable users must
#      see the exact same thing from either feed.
#
# Config (env overrides):
#   BASE   releases.shogo.ai base URL   (default: https://releases.shogo.ai)
#   UEO    update.electronjs.org base   (default: https://update.electronjs.org/shogo-labs/shogo-ai)
#   OLD_V  version guaranteed older than every release (default: 0.0.1)
#   NEW_V  version guaranteed newer than every release  (default: 99.0.0)
#
#   ./scripts/check-desktop-feed.sh
set -uo pipefail

BASE="${BASE:-https://releases.shogo.ai}"
UEO="${UEO:-https://update.electronjs.org/shogo-labs/shogo-ai}"
OLD_V="${OLD_V:-0.0.1}"
NEW_V="${NEW_V:-99.0.0}"
CURL_OPTS=(--connect-timeout 5 --max-time 20 -s)

HAVE_JQ=1
command -v jq >/dev/null 2>&1 || HAVE_JQ=0

FAILED=0
pass(){ echo "  PASS: $*"; }
fail(){ echo "  FAIL: $*"; FAILED=1; }
hdr(){ echo "===== $* ====="; }

json_field() {
  # json_field <json> <field> — best-effort extraction; uses jq if present,
  # otherwise a crude grep fallback (good enough for {"name":"...","url":"..."}).
  local json="$1" field="$2"
  if [ "$HAVE_JQ" = "1" ]; then
    echo "$json" | jq -r --arg f "$field" '.[$f] // empty' 2>/dev/null
  else
    echo "$json" | grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'
  fi
}

# --- 1. beta offers an update for an ancient version ------------------------
hdr "1. beta feed offers an update (darwin-arm64, v$OLD_V)"
BODY=$(curl "${CURL_OPTS[@]}" -w '\n%{http_code}' "$BASE/desktop/beta/darwin-arm64/$OLD_V")
CODE=$(echo "$BODY" | tail -1)
JSON=$(echo "$BODY" | sed '$d')
if [ "$CODE" = "200" ]; then
  pass "GET /desktop/beta/darwin-arm64/$OLD_V -> 200"
  URL=$(json_field "$JSON" url)
  case "$URL" in
    *Shogo-darwin-arm64*.zip) pass "offer url points at a darwin-arm64 zip ($URL)" ;;
    *) fail "offer url doesn't look like a darwin-arm64 zip: '${URL:-<empty>}'" ;;
  esac
  NAME=$(json_field "$JSON" name)
  [ -n "$NAME" ] && pass "offer name present ('$NAME')" || fail "offer JSON missing 'name'"
else
  fail "GET /desktop/beta/darwin-arm64/$OLD_V -> $CODE (expected 200); body: $JSON"
fi

# --- 2. beta reports up to date for a version nothing will ever exceed -----
hdr "2. beta feed reports up to date (darwin-arm64, v$NEW_V)"
CODE=$(curl "${CURL_OPTS[@]}" -o /dev/null -w '%{http_code}' "$BASE/desktop/beta/darwin-arm64/$NEW_V")
[ "$CODE" = "204" ] && pass "GET /desktop/beta/darwin-arm64/$NEW_V -> 204" \
  || fail "GET /desktop/beta/darwin-arm64/$NEW_V -> $CODE (expected 204)"

# --- 3. Squirrel.Windows RELEASES file rewrite -------------------------------
hdr "3. beta RELEASES file has an absolute nupkg URL (win32-x64, v$OLD_V)"
RELEASES_BODY=$(curl "${CURL_OPTS[@]}" -w '\n%{http_code}' "$BASE/desktop/beta/win32-x64/$OLD_V/RELEASES")
RELEASES_CODE=$(echo "$RELEASES_BODY" | tail -1)
RELEASES_TEXT=$(echo "$RELEASES_BODY" | sed '$d')
if [ "$RELEASES_CODE" = "200" ]; then
  pass "GET /desktop/beta/win32-x64/$OLD_V/RELEASES -> 200"
  if echo "$RELEASES_TEXT" | grep -qE 'https?://[^ ]+\.nupkg'; then
    pass "RELEASES body contains an absolute .nupkg URL"
  else
    fail "RELEASES body has no absolute .nupkg URL: $(echo "$RELEASES_TEXT" | head -1)"
  fi
else
  fail "GET /desktop/beta/win32-x64/$OLD_V/RELEASES -> $RELEASES_CODE (expected 200); body: $RELEASES_TEXT"
fi

# --- 4. stable/update.electronjs.org parity ---------------------------------
hdr "4. stable feed parity with update.electronjs.org"
for PLATFORM in darwin-arm64 darwin-x64 win32-x64; do
  for V in "$OLD_V" "$NEW_V"; do
    OURS_CODE=$(curl "${CURL_OPTS[@]}" -o /tmp/check-desktop-feed-ours.$$ -w '%{http_code}' "$BASE/desktop/stable/$PLATFORM/$V")
    OURS_BODY=$(cat /tmp/check-desktop-feed-ours.$$ 2>/dev/null); rm -f /tmp/check-desktop-feed-ours.$$
    UEO_CODE=$(curl "${CURL_OPTS[@]}" -o /tmp/check-desktop-feed-ueo.$$ -w '%{http_code}' "$UEO/$PLATFORM/$V")
    UEO_BODY=$(cat /tmp/check-desktop-feed-ueo.$$ 2>/dev/null); rm -f /tmp/check-desktop-feed-ueo.$$

    if [ "$OURS_CODE" != "$UEO_CODE" ]; then
      fail "$PLATFORM/$V: status mismatch — ours=$OURS_CODE update.electronjs.org=$UEO_CODE"
      continue
    fi

    if [ "$OURS_CODE" = "200" ]; then
      OURS_NAME=$(json_field "$OURS_BODY" name)
      UEO_NAME=$(json_field "$UEO_BODY" name)
      if [ "$OURS_NAME" = "$UEO_NAME" ]; then
        pass "$PLATFORM/$V: both -> 200, offered '$OURS_NAME'"
      else
        fail "$PLATFORM/$V: offered name mismatch — ours='$OURS_NAME' update.electronjs.org='$UEO_NAME'"
      fi
    else
      pass "$PLATFORM/$V: both -> $OURS_CODE"
    fi
  done
done

# --- result -------------------------------------------------------------
echo
if [ "$FAILED" = "0" ]; then
  echo "===== DESKTOP FEED CHECK: ALL PASSED ====="
  exit 0
else
  echo "===== DESKTOP FEED CHECK: FAILURES ABOVE ====="
  exit 1
fi
