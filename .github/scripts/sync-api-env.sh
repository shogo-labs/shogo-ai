#!/usr/bin/env bash
# .github/scripts/sync-api-env.sh
#
# Idempotently set a single env var on the `api` Knative Service in a
# given namespace. The value is verified after patching; the step fails
# loudly if the post-patch value does not match the expected value.
#
# Background — the 2026-05-27 502 incident:
#
# The previous inline implementation in deploy.yml looked like:
#
#   IDX=$(kubectl get ksvc api ... | python3 -c "..." 2>/dev/null) || IDX="-1"
#   if [ -n "$IDX" ] && [ "$IDX" != "-1" ]; then
#     CURRENT=$(kubectl get ksvc api ...)
#     if [ "$CURRENT" != "$RUNTIME_IMAGE" ]; then
#       kubectl patch ksvc api ...
#     fi
#   fi
#
# Two ways this silently passed under `bash -eo pipefail` (the GH Actions
# default) while doing nothing useful:
#
#   (a) Any non-zero from kubectl or python3 was swallowed by the
#       `2>/dev/null` + `|| IDX="-1"` pair, dropping straight into the
#       no-op branch.
#   (b) A successful `kubectl patch` with no post-patch verification meant
#       even a webhook-rejected patch (or an entirely missing patch) was
#       indistinguishable from success at the workflow level.
#
# The end result on EU and India during the v1.8.13 deploy was that
# RUNTIME_IMAGE on the api ksvc kept the kustomize overlay placeholder
# `:production-bootstrap`, the warm-pool controller minted pods with
# that non-existent image, every warm pod went ImagePullBackOff, and
# once the existing warm pool drained the cluster threw 502s for new
# project requests.
#
# This script replaces that pattern with:
#   * `set -euo pipefail` — non-zero from any command fails the step
#   * jq for JSON parsing — no `2>/dev/null` muting of real errors
#   * ADD if missing — instead of silently skipping when the env var
#     was never declared on the ksvc spec
#   * post-patch verify via a fresh `kubectl get` — fails the step if
#     the value didn't actually land
#   * a guardrail that rejects RUNTIME_IMAGE values containing
#     "bootstrap" (the overlay placeholder), so we never re-enter the
#     ImagePullBackOff state via a misconfigured runtime-tag step
#
# Usage:
#   .github/scripts/sync-api-env.sh <namespace> <env-name> <expected-value>

set -euo pipefail

NS="${1:?namespace required}"
NAME="${2:?env name required}"
EXPECTED="${3?expected value required (pass empty string explicitly if intended)}"

# Defense-in-depth against the 2026-05-27 footgun. RUNTIME_IMAGE is now
# rendered into the api ksvc at apply time (deploy.yml's "Apply Kubernetes
# manifests" step substitutes RUNTIME_IMAGE_PLACEHOLDER with the resolved
# immutable tag), so the old literal `:<env>-bootstrap` placeholder no
# longer ships in the overlays. This step still runs as a verify/no-op. If
# the runtime-tag step ever resolves back to a `bootstrap` value (e.g. a
# misread configmap or broken variable interpolation), refuse to apply it
# rather than re-arm the bug.
if [[ "$NAME" == "RUNTIME_IMAGE" && "$EXPECTED" == *bootstrap* ]]; then
  echo "::error::sync-api-env: refusing to pin RUNTIME_IMAGE to placeholder value '$EXPECTED'"
  exit 1
fi

echo "Syncing env $NAME on ksvc/api in namespace $NS"
echo "  expected: $EXPECTED"

get_idx() {
  kubectl get ksvc api -n "$NS" -o json \
    | jq -r --arg name "$NAME" '
        (.spec.template.spec.containers[0].env // [])
        | map(.name)
        | index($name) // -1
      '
}

get_current_value() {
  kubectl get ksvc api -n "$NS" -o json \
    | jq -r --arg name "$NAME" '
        ((.spec.template.spec.containers[0].env // [])
         | map(select(.name == $name))
         | first
        ).value // ""
      '
}

apply_patch() {
  local idx
  idx=$(get_idx)
  if [[ "$idx" == "-1" ]]; then
    echo "  $NAME missing on ksvc/api — adding"
    kubectl patch ksvc api -n "$NS" --type='json' -p="[
      {\"op\": \"add\", \"path\": \"/spec/template/spec/containers/0/env/-\", \"value\": {\"name\": \"$NAME\", \"value\": \"$EXPECTED\"}}
    ]"
    return
  fi

  local current
  current=$(get_current_value)
  if [[ "$current" == "$EXPECTED" ]]; then
    echo "  $NAME already correct — no patch"
    return
  fi
  echo "  Updating $NAME: '$current' -> '$EXPECTED'"
  kubectl patch ksvc api -n "$NS" --type='json' -p="[
    {\"op\": \"replace\", \"path\": \"/spec/template/spec/containers/0/env/${idx}/value\", \"value\": \"$EXPECTED\"}
  ]"
}

apply_patch

# Re-read the ksvc and assert the value actually landed. The Knative
# admission webhook serializes spec mutations through etcd, so a brief
# retry absorbs webhook settle latency without masking real failures.
attempts=0
while true; do
  current=$(get_current_value)
  if [[ "$current" == "$EXPECTED" ]]; then
    echo "  ✓ verified: $NAME = $EXPECTED"
    break
  fi
  attempts=$((attempts + 1))
  if [[ "$attempts" -ge 5 ]]; then
    echo "::error::sync-api-env: post-patch verify failed for $NAME on ksvc/api in $NS — got '$current', want '$EXPECTED'"
    exit 1
  fi
  sleep 2
done
