#!/usr/bin/env bash
# .github/scripts/render-image-prepuller.sh
#
# Render `k8s/base/image-prepuller.yaml` for one deploy. In order:
#
#   1. RUNTIME_IMAGE_PLACEHOLDER -> RUNTIME_IMAGE
#   2. `namespace: shogo-staging-system` -> NS_SYSTEM
#   3. PREPULL_EXTRA_PLACEHOLDER  -> up to PREPULL_MAX_EXTRA extra `sleep
#      infinity` containers, one per `shogo-runtime` tag that PUBLISHED APPS
#      WHICH ARE ALWAYS ON actually use.
#
# Why (SHO-592 §2)
# ----------------
# The prepuller only ever pulled the deploy's own RUNTIME_IMAGE. When KIF CRM's
# replacement pod was scheduled onto a node the autoscaler had created 26
# minutes earlier, that node had never pulled KIF's tag: it spent 16m42s pulling
# `production-121eb463` while KIF was down.
#
# Prod today has 29 distinct runtime tags across 131 ksvcs, but only 10 tags
# across the 14 always-on (min-scale >= 1) apps. At ~9 GB each that is ~90 GB
# for the always-on tags alone on every node, and ~260 GB for all of them — the
# boot disk is 189 GB, so "prepull everything in use" would recreate exactly the
# incident this card is about. Hence a CAP: the deploy's own tag plus at most
# PREPULL_MAX_EXTRA more, ranked by how many always-on apps use them.
#
# Caveat that belongs in the PR, not in a comment nobody reads: this does NOT
# cover a tag used by only one always-on app when the cap is reached. Today KIF
# (`production-121eb463`, 1 always-on app) is in that position. Making it
# covered means either raising the cap (each extra tag is ~9 GB per node and
# ~6 more minutes of cold-node pull) or converging always-on apps onto the
# deploy tag — the open design question on the card.
#
# Env:
#   RUNTIME_IMAGE     (required) the tag this deploy rolls out
#   NS_SYSTEM         (required) namespace the prepuller lands in
#   NS_WORKSPACES     published apps' ksvc namespace (no value = no extras)
#   PREPULL_MAX_EXTRA default 3   max extra tags beyond RUNTIME_IMAGE
#   KSVC_JSON_FILE    read the ksvc list from this file instead of kubectl
#                     (tests; also lets a re-render reproduce a deploy exactly)
#   PREPULL_COUNT_OUT optional file to write the number of extras rendered, so
#                     the caller can scale the prepull gate's timeout
#
# Stdout is the manifest (pipe it to `kubectl apply -f -`); every human-facing
# line goes to stderr, so a `kubectl apply` failure is never fed prose.

set -euo pipefail

: "${RUNTIME_IMAGE:?RUNTIME_IMAGE required}"
: "${NS_SYSTEM:?NS_SYSTEM required}"
NS_WORKSPACES="${NS_WORKSPACES:-}"
PREPULL_MAX_EXTRA="${PREPULL_MAX_EXTRA:-3}"
KSVC_JSON_FILE="${KSVC_JSON_FILE:-}"
PREPULL_COUNT_OUT="${PREPULL_COUNT_OUT:-}"

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPTS/../.." && pwd)"
MANIFEST="$REPO_ROOT/k8s/base/image-prepuller.yaml"

log() { echo "[image-prepuller] $*" >&2; }

# Ranked "apps<TAB>image" lines: always-on shogo-runtime tags this deploy is not
# already pulling, most-used first. Ties break on the image name so the same
# cluster state always renders the same manifest (a flap in ordering would
# restart every prepuller pod for no reason).
rank_images() {
  jq -r --arg runtime "$RUNTIME_IMAGE" '
    def minscale:
      ((.spec.template.metadata.annotations // {})["autoscaling.knative.dev/min-scale"]
       // (.metadata.annotations // {})["autoscaling.knative.dev/min-scale"]
       // "0") | tonumber? // 0;
    [ (.items // [])[]
      | select(minscale >= 1)
      | (.spec.template.spec.containers[0].image // "")
      | select(. != "")
      | select(test("/shogo-runtime:"))
    ]
    | group_by(.)
    | map({ image: .[0], apps: length })
    | map(select(.image != $runtime))
    | sort_by(-.apps, .image)
    | .[] | "\(.apps)\t\(.image)"
  '
}

ksvc_json() {
  if [ -n "$KSVC_JSON_FILE" ]; then
    cat "$KSVC_JSON_FILE"
    return 0
  fi
  if [ -z "$NS_WORKSPACES" ]; then
    echo '{"items":[]}'
    return 0
  fi
  # A failed listing must never fail the deploy — extras are an optimization,
  # and the deploy's own image is applied either way.
  kubectl get ksvc -n "$NS_WORKSPACES" -o json 2>/dev/null || echo '{"items":[]}'
}

extras_yaml() {
  local n=0 apps image
  while IFS="$(printf '\t')" read -r apps image; do
    [ -n "${image:-}" ] || continue
    n=$((n + 1))
    cat <<YAML
        # ${apps} always-on published app(s) run this tag; the deploy's own
        # RUNTIME_IMAGE is above. Pulled so an evicted app's replacement pod
        # does not spend ~15 minutes pulling it on a cold node (SHO-592).
        - name: runtime-prepull-extra-${n}
          image: ${image}
          # Immutable :<env>-<sha> tag, so there is nothing to re-resolve.
          imagePullPolicy: IfNotPresent
          command: ["sleep", "infinity"]
          resources:
            requests:
              memory: "16Mi"
              cpu: "1m"
            limits:
              memory: "32Mi"
              cpu: "10m"
          securityContext:
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 1000
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
YAML
  done
}

ranked="$(ksvc_json | rank_images)"
extras="$(printf '%s\n' "$ranked" | grep -v '^$' | head -n "$PREPULL_MAX_EXTRA" | extras_yaml || true)"
count="$(printf '%s\n' "$ranked" | grep -vc '^$' || true)"
rendered="$(printf '%s\n' "$extras" | grep -c '^        - name: runtime-prepull-extra-' || true)"

if [ "${rendered:-0}" -gt 0 ]; then
  printf '%s\n' "$extras" | grep '^          image:' | sed 's/^ *image: /  + /' >&2 || true
  log "prepulling ${rendered} extra always-on runtime tag(s) (cap ${PREPULL_MAX_EXTRA}; ${count} distinct outside this deploy)"
  log "budget: each extra tag is ~9 GB per node and ~6 min on a cold node"
else
  log "no extra runtime tags to prepull (cap ${PREPULL_MAX_EXTRA}; ${count:-0} distinct outside this deploy)"
fi

if [ -n "$PREPULL_COUNT_OUT" ]; then
  printf '%s' "${rendered:-0}" >"$PREPULL_COUNT_OUT"
fi

sed -e "s|RUNTIME_IMAGE_PLACEHOLDER|${RUNTIME_IMAGE}|g" \
    -e "s|namespace: shogo-staging-system|namespace: ${NS_SYSTEM}|g" \
    "$MANIFEST" \
  | BLOCK="$extras" awk '
      /PREPULL_EXTRA_PLACEHOLDER/ { printf "%s\n", ENVIRON["BLOCK"]; next }
      { print }
    '
