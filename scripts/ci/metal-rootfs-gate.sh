#!/usr/bin/env bash
# =============================================================================
# metal-rootfs-gate.sh — should this release rebuild the metal fleet's rootfs?
# =============================================================================
# Rebuilding the golden rootfs re-stamps its identity, which invalidates EVERY
# snapshot on every host: each project then cold-boots on its next open instead
# of resuming (2026-08-09: ~6,500 snapshots and a day of 524s). It is the right
# price when guests have new code to run and pure loss when they do not.
#
# So ask the fleet which guest revision it actually runs. Each host reports the
# commit stamped inside its rootfs (/etc/shogo-runtime-revision, read by
# apps/metal-agent self-update.ts) through GET /api/internal/metal/fleet. Skip
# the rebuild only when every live host in every control plane reports the same
# revision R and nothing in the runtime chain changed between R and this commit.
# Anything short of that certainty rebuilds: a needless rebuild costs a
# cold-boot storm, a skipped one leaves guests on stale code indefinitely.
#
# Hosts whose image predates the revision stamp report none. For those only,
# fall back to .github/runtime-image-baseline (the hand-maintained record this
# gate replaces), with a warning. Remove the fallback once every host reports.
#
# Usage:
#   fetch  <label> <control-plane-url>        one JSON line on stdout, always exit 0
#          env: METAL_REGISTER_TOKEN, INSECURE_TLS=true to skip TLS verify
#   decide <sha> <fleet-file>...              `rebuild=` and `reason=` lines on stdout
#          env: BASELINE_FILE (default .github/runtime-image-baseline),
#               GITHUB_STEP_SUMMARY (optional, gets a per-host table)
#   check  <sha> <label>=<url>...             fetch every control plane, then decide
#          env: METAL_REGISTER_TOKEN_<LABEL> (label upper-cased, - → _), or
#               METAL_REGISTER_TOKEN for all
# =============================================================================
set -euo pipefail

# Everything that composes the guest image. Mirrors the push filter in
# .github/workflows/runtime-multiarch.yml, the repo's definition of "the runtime
# chain changed"; keep the two in step.
RUNTIME_PATHS=(
  'packages/agent-runtime'
  'packages/shared-runtime'
  'docker/workspace-deps/Dockerfile'
  'templates/runtime-template'
  'package.json'
  'bun.lock'
  '.github/workflows/runtime-multiarch.yml'
)

log() { echo "$*" >&2; }

cmd_fetch() {
  local label="$1" url="$2"
  local -a opts=(-sS -m 20 -w '\n%{http_code}')
  [[ "${INSECURE_TLS:-}" == "true" ]] && opts+=(-k)
  local out code body
  if [[ -z "${METAL_REGISTER_TOKEN:-}" ]]; then
    jq -cn --arg cp "$label" '{cp:$cp, ok:false, error:"no METAL_REGISTER_TOKEN"}'
    return 0
  fi
  if ! out=$(curl "${opts[@]}" -H "Authorization: Bearer $METAL_REGISTER_TOKEN" "${url%/}/api/internal/metal/fleet" 2>&1); then
    jq -cn --arg cp "$label" --arg e "$out" '{cp:$cp, ok:false, error:("request failed: " + $e)}'
    return 0
  fi
  code="${out##*$'\n'}"
  body="${out%$'\n'*}"
  if [[ "$code" != "200" ]] || ! jq -e '.ok == true and (.hosts | type == "array")' >/dev/null 2>&1 <<<"$body"; then
    jq -cn --arg cp "$label" --arg code "$code" '{cp:$cp, ok:false, error:("HTTP " + $code)}'
    return 0
  fi
  jq -c --arg cp "$label" \
    '{cp:$cp, ok:true, hosts:[.hosts[] | {hostId, region, rootfsRevision:(.rootfsRevision // null)}]}' <<<"$body"
}

# Resolve a revision to a full commit sha in this checkout, or print nothing.
resolve() { git rev-parse -q --verify "${1}^{commit}" 2>/dev/null || true; }

baseline() {
  local f="${BASELINE_FILE:-.github/runtime-image-baseline}"
  grep -v '^[[:space:]]*#' "$f" 2>/dev/null | grep -v '^[[:space:]]*$' | head -1 | tr -d '[:space:]' || true
}

emit() {
  echo "rebuild=$1"
  echo "reason=$2"
  log "rootfs rebuild=$1 — $2"
}

summary() {
  local rows="$1" decision="$2" reason="$3"
  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] || return 0
  {
    echo "### Metal rootfs gate: rebuild=$decision"
    echo
    echo "$reason"
    echo
    echo "| Control plane | Host | Region | rootfsRevision |"
    echo "|---|---|---|---|"
    if [[ -n "$rows" ]]; then
      while IFS=$'\t' read -r cp host region rev; do
        echo "| $cp | $host | $region | ${rev:-_none_} |"
      done <<<"$rows"
    fi
  } >>"$GITHUB_STEP_SUMMARY"
}

cmd_decide() {
  local sha="$1"; shift
  local rows="" problems=() f rec
  for f in "$@"; do
    rec=$(cat "$f" 2>/dev/null || true)
    if [[ -z "$rec" ]] || ! jq -e 'type == "object" and has("cp")' >/dev/null 2>&1 <<<"$rec"; then
      problems+=("fleet status $(basename "$f") is missing or unreadable")
      continue
    fi
    local cp; cp=$(jq -r '.cp' <<<"$rec")
    if [[ "$(jq -r '.ok' <<<"$rec")" != "true" ]]; then
      problems+=("control plane $cp unreachable: $(jq -r '.error // "unknown"' <<<"$rec")")
      continue
    fi
    if [[ "$(jq '.hosts | length' <<<"$rec")" == "0" ]]; then
      problems+=("control plane $cp reports no live hosts")
      continue
    fi
    rows+=$(jq -r --arg cp "$cp" '.hosts[] | [$cp, .hostId, .region, (.rootfsRevision // "")] | @tsv' <<<"$rec")$'\n'
  done
  rows="${rows%$'\n'}"
  [[ -n "$rows" ]] && while IFS=$'\t' read -r cp host region rev; do log "  $cp $host ($region): ${rev:-no revision}"; done <<<"$rows"

  if [[ ${#problems[@]} -gt 0 ]]; then
    local why; why=$(IFS='; '; echo "${problems[*]}")
    emit true "$why"; summary "$rows" true "$why"; return 0
  fi

  local head; head=$(resolve "$sha")
  if [[ -z "$head" ]]; then
    emit true "release commit $sha does not resolve here"; summary "$rows" true "release commit $sha does not resolve here"; return 0
  fi

  # Distinct revisions, with legacy (unstamped) hosts standing in as the baseline.
  local legacy base="" revs=()
  legacy=$(awk -F'\t' '$4 == ""' <<<"$rows" | wc -l | tr -d ' ')
  if [[ "$legacy" != "0" ]]; then
    base=$(baseline)
    if [[ -z "$base" ]]; then
      emit true "$legacy host(s) report no revision and no baseline is recorded"
      summary "$rows" true "$legacy host(s) report no revision and no baseline is recorded"; return 0
    fi
    local base_full; base_full=$(resolve "$base")
    if [[ -z "$base_full" ]]; then
      emit true "$legacy host(s) report no revision and baseline $base does not resolve"
      summary "$rows" true "$legacy host(s) report no revision and baseline $base does not resolve"; return 0
    fi
    echo "::warning::$legacy host(s) report no rootfs revision (image predates the stamp); assuming baseline $base for them" >&2
    revs+=("$base_full")
  fi
  local rev full
  while IFS= read -r rev; do
    [[ -n "$rev" ]] || continue
    full=$(resolve "$rev")
    if [[ -z "$full" ]]; then
      emit true "host revision $rev does not resolve here"; summary "$rows" true "host revision $rev does not resolve here"; return 0
    fi
    revs+=("$full")
  done < <(awk -F'\t' '$4 != "" {print $4}' <<<"$rows" | sort -u)

  local distinct; distinct=$(printf '%s\n' "${revs[@]}" | sort -u)
  if [[ $(wc -l <<<"$distinct" | tr -d ' ') -gt 1 ]]; then
    local why
    why="hosts disagree on the guest revision: $(tr '\n' ' ' <<<"$distinct" | sed 's/ $//')"
    emit true "$why"; summary "$rows" true "$why"; return 0
  fi

  local r="$distinct"
  if ! git diff --quiet "$r" "$head" -- "${RUNTIME_PATHS[@]}"; then
    git diff --name-only "$r" "$head" -- "${RUNTIME_PATHS[@]}" | head -20 | sed 's/^/    /' >&2 || true
    emit true "guest image changed since ${r:0:12}, the revision every host runs"
    summary "$rows" true "guest image changed since \`${r:0:12}\`, the revision every host runs"; return 0
  fi
  emit false "guest image unchanged since ${r:0:12}, the revision every host runs"
  summary "$rows" false "guest image unchanged since \`${r:0:12}\`, the revision every host runs"
}

cmd_check() {
  local sha="$1"; shift
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  local spec label url var files=()
  for spec in "$@"; do
    label="${spec%%=*}"; url="${spec#*=}"
    var="METAL_REGISTER_TOKEN_$(tr '[:lower:]-' '[:upper:]_' <<<"$label")"
    METAL_REGISTER_TOKEN="${!var:-${METAL_REGISTER_TOKEN:-}}" cmd_fetch "$label" "$url" >"$tmp/$label.json"
    files+=("$tmp/$label.json")
  done
  cmd_decide "$sha" "${files[@]}"
}

case "${1:-}" in
  fetch) shift; [[ $# -eq 2 ]] || { log "usage: $0 fetch <label> <url>"; exit 2; }; cmd_fetch "$@" ;;
  decide) shift; [[ $# -ge 2 ]] || { log "usage: $0 decide <sha> <fleet-file>..."; exit 2; }; cmd_decide "$@" ;;
  check) shift; [[ $# -ge 2 ]] || { log "usage: $0 check <sha> <label>=<url>..."; exit 2; }; cmd_check "$@" ;;
  *) log "usage: $0 {fetch|decide|check} ..."; exit 2 ;;
esac
