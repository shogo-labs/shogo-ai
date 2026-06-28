#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Shogo Technologies, Inc.
#
# Customer.io Campaign Setup
# ==========================
# Idempotent script that provisions the Shogo lifecycle campaigns, segments,
# and email templates via the Customer.io Journeys API (service account token).
#
# What this script does automatically:
#   1. Authenticates the CIO CLI with the service account token
#   2. Creates (or verifies) all 4 campaigns
#   3. Creates (or verifies) all 3 audience segments
#   4. Uploads all 11 email HTML templates as transactional messages (for reference)
#   5. Prints exact UI URLs for the workflow steps that require manual configuration
#
# The only manual work after running this script is opening each campaign's
# workflow editor and connecting the trigger → email steps → exit node. This
# takes about 5 minutes total and the exact click-paths are printed below.
#
# Prerequisites:
#   bun x cio auth login must already have run, OR set CUSTOMERIO_SA_TOKEN
#
# Usage:
#   CUSTOMERIO_SA_TOKEN=sa_live_... bash scripts/setup-customerio.sh
#
# Or if already authenticated via the CIO CLI:
#   bash scripts/setup-customerio.sh

set -euo pipefail

SA_TOKEN="${CUSTOMERIO_SA_TOKEN:-}"
ENV_ID="223937"
BASE="https://us.fly.customer.io/v1/environments/${ENV_ID}"
UI_BASE="https://fly.customer.io/env/${ENV_ID}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${BLUE}ℹ${NC}  $*" >&2; }
success() { echo -e "${GREEN}✓${NC}  $*" >&2; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*" >&2; }
error()   { echo -e "${RED}✗${NC}  $*" >&2; }
heading() { echo -e "\n${BOLD}${CYAN}$*${NC}" >&2; }
link()    { echo -e "   ${BLUE}→${NC}  $*"; }

# ─── Auth ─────────────────────────────────────────────────────────────────────

heading "Step 0: Authentication"

if [[ -n "$SA_TOKEN" ]]; then
  echo "$SA_TOKEN" | bun x cio auth login --with-token > /dev/null 2>&1
  success "Authenticated with CUSTOMERIO_SA_TOKEN"
fi

ACCESS_TOKEN=$(python3 -c "
import json, sys
try:
    with open('$HOME/.cio/config.json') as f:
        d = json.load(f)
    tok = d['profiles']['default'].get('access_token','')
    if not tok:
        sys.exit(1)
    print(tok)
except:
    sys.exit(1)
" 2>/dev/null) || {
  error "Not authenticated. Run: echo \$CUSTOMERIO_SA_TOKEN | bun x cio auth login --with-token"
  exit 1
}

cio_get()  { curl -sf "${BASE}$1" -H "Authorization: Bearer ${ACCESS_TOKEN}" --max-time 15; }
cio_post() { curl -sf -X POST "${BASE}$1" -H "Authorization: Bearer ${ACCESS_TOKEN}" -H "Content-Type: application/json" -d "$2" --max-time 15; }
cio_put()  { curl -sf -X PUT "${BASE}$1" -H "Authorization: Bearer ${ACCESS_TOKEN}" -H "Content-Type: application/json" -d "$2" --max-time 15; }

success "CIO CLI authenticated (env ${ENV_ID})"

# ─── Track API credentials ────────────────────────────────────────────────────

heading "Step 1: Validating Track API credentials"

SITE_ID="${CUSTOMERIO_SITE_ID:-}"
TRACKING_KEY="${CUSTOMERIO_TRACKING_API_KEY:-}"

if [[ -z "$SITE_ID" || -z "$TRACKING_KEY" ]]; then
  warn "CUSTOMERIO_SITE_ID / CUSTOMERIO_TRACKING_API_KEY not set — skipping Track API check."
  warn "Set them or run: dotenv -f apps/api/.env -- bash scripts/setup-customerio.sh"
else
  AUTH_HEADER="$(echo -n "${SITE_ID}:${TRACKING_KEY}" | base64)"
  TRACK_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PUT "https://track.customer.io/api/v1/customers/shogo-setup-probe" \
    -H "Content-Type: application/json" \
    -H "Authorization: Basic ${AUTH_HEADER}" \
    -d '{"email":"setup-probe@shogo.ai","_delete":true}')
  if [[ "$TRACK_STATUS" == "200" || "$TRACK_STATUS" == "201" ]]; then
    success "Track API OK (site_id: ${SITE_ID})"
  else
    warn "Track API returned HTTP ${TRACK_STATUS}. Check credentials."
  fi
fi

# ─── Campaigns ────────────────────────────────────────────────────────────────

heading "Step 2: Campaigns"

# Helper: create campaign if not already present
create_campaign_if_missing() {
  local NAME="$1"
  local TYPE="$2"
  local DESC="$3"
  local EXISTING_ID="${4:-}"

  if [[ -n "$EXISTING_ID" ]]; then
    EXISTING=$(cio_get "/campaigns/${EXISTING_ID}" 2>/dev/null || echo "{}")
    EXISTING_NAME=$(echo "$EXISTING" | python3 -c "import sys,json; print(json.load(sys.stdin).get('campaign',{}).get('name',''))" 2>/dev/null || echo "")
    if [[ "$EXISTING_NAME" == "$NAME" ]]; then
      success "Campaign already exists: \"${NAME}\" (id: ${EXISTING_ID})"
      echo "$EXISTING_ID"
      return
    fi
  fi

  RESULT=$(cio_post "/campaigns" "{\"campaign\":{\"name\":\"${NAME}\",\"type\":\"${TYPE}\",\"description\":\"${DESC}\"}}")
  ID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('campaign',{}).get('id',''))" 2>/dev/null || echo "")
  if [[ -n "$ID" ]]; then
    success "Created campaign: \"${NAME}\" (id: ${ID})"
    echo "$ID"
  else
    error "Failed to create campaign: $NAME"
    echo "err"
  fi
}

CAMP_A=$(create_campaign_if_missing \
  "Onboarding Drip" \
  "behavioral" \
  "8-email sequence for new free users — drives them to first agent tool call within 14 days" \
  "1")

CAMP_C1=$(create_campaign_if_missing \
  "Conversion: Usage Limit Hit" \
  "behavioral" \
  "Triggered when a free user hits their usage window. Shows the Pro upgrade value prop." \
  "2")

CAMP_C2=$(create_campaign_if_missing \
  "Conversion: Power User Recognition" \
  "seg_attr" \
  "Sent when a free user crosses 50+ chat messages. Positions annual Pro pricing." \
  "3")

CAMP_C3=$(create_campaign_if_missing \
  "Win-Back: Inactive Users" \
  "behavioral" \
  "Sent to free users who have not sent a chat message in 7 days." \
  "4")

# ─── Segments ─────────────────────────────────────────────────────────────────

heading "Step 3: Audience segments"

create_segment_if_missing() {
  local NAME="$1"
  local DESC="$2"
  local CONDITIONS="$3"
  local EXISTING_ID="${4:-}"

  if [[ -n "$EXISTING_ID" ]]; then
    EXISTING=$(cio_get "/segments/${EXISTING_ID}" 2>/dev/null || echo "{}")
    EXISTING_NAME=$(echo "$EXISTING" | python3 -c "import sys,json; print(json.load(sys.stdin).get('segment',{}).get('name',''))" 2>/dev/null || echo "")
    if [[ "$EXISTING_NAME" == "$NAME" ]]; then
      success "Segment already exists: \"${NAME}\" (id: ${EXISTING_ID})"
      echo "$EXISTING_ID"
      return
    fi
  fi

  PAYLOAD=$(python3 -c "
import json, sys
payload = {
    'segment': {
        'name': sys.argv[1],
        'description': sys.argv[2],
        'type': 'dynamic',
        'conditions': json.loads(sys.argv[3])
    }
}
print(json.dumps(payload))
" "$NAME" "$DESC" "$CONDITIONS")

  RESULT=$(cio_post "/segments" "$PAYLOAD")
  ID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('segment',{}).get('id',''))" 2>/dev/null || echo "")
  if [[ -n "$ID" ]]; then
    success "Created segment: \"${NAME}\" (id: ${ID})"
    echo "$ID"
  else
    error "Failed to create segment: $NAME (response: $RESULT)"
    echo "err"
  fi
}

FREE_USERS_CONDITIONS='{"and":[{"event":{"filters":{"and":[{"field":"to","inverse":false,"operator":"eq","value":"pro"}]},"name":"plan","type":"attribute_change"},"inverse":true,"times":1,"within":0}]}'
POWER_USERS_CONDITIONS='{"and":[{"event":{"filters":{},"name":"chat_message_sent","type":"event"},"inverse":false,"times":50,"within":0},{"event":{"filters":{"and":[{"field":"to","inverse":false,"operator":"eq","value":"pro"}]},"name":"plan","type":"attribute_change"},"inverse":true,"times":1,"within":0}]}'
INACTIVE_USERS_CONDITIONS='{"and":[{"event":{"filters":{},"name":"chat_message_sent","type":"event"},"inverse":true,"times":1,"within":604800},{"event":{"filters":{"and":[{"field":"to","inverse":false,"operator":"eq","value":"pro"}]},"name":"plan","type":"attribute_change"},"inverse":true,"times":1,"within":0}]}'

SEG_FREE=$(create_segment_if_missing \
  "Free Users" \
  "Users whose plan attribute has never been set to pro (no paid subscription)" \
  "$FREE_USERS_CONDITIONS" \
  "15")

SEG_POWER=$(create_segment_if_missing \
  "Power Users (Free)" \
  "Free users who have sent 50+ chat messages" \
  "$POWER_USERS_CONDITIONS" \
  "16")

SEG_INACTIVE=$(create_segment_if_missing \
  "Inactive Free Users" \
  "Free users who have not sent a chat message in the last 7 days" \
  "$INACTIVE_USERS_CONDITIONS" \
  "17")

# ─── Email templates (transactional messages) ─────────────────────────────────

heading "Step 4: Email templates"

# Render HTML from the TypeScript email templates using bun
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

render_template_html() {
  local TEMPLATE_NAME="$1"
  bun --cwd "${REPO_ROOT}" run - <<BUNSCRIPT 2>/dev/null
import { allTemplates } from './packages/email/src/templates/index.js'
const t = allTemplates.find(t => t.name === '${TEMPLATE_NAME}')
if (!t) { process.stderr.write('Template not found: ${TEMPLATE_NAME}\n'); process.exit(1) }
let html = t.html
if (t.defaults) {
  for (const [k,v] of Object.entries(t.defaults)) {
    html = html.replaceAll('{{' + k + '}}', v)
  }
}
process.stdout.write(html)
BUNSCRIPT
}

create_transactional_message() {
  local NAME="$1"
  local SUBJECT="$2"
  local TEMPLATE_NAME="$3"

  # Check if already exists
  EXISTING=$(cio_get "/transactional_messages" 2>/dev/null || echo '{"transactional_messages":[]}')
  EXISTING_ID=$(echo "$EXISTING" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for m in d.get('transactional_messages',[]):
    if m.get('name','') == sys.argv[1]:
        print(m.get('id',''))
        break
" "$NAME" 2>/dev/null || echo "")

  if [[ -n "$EXISTING_ID" ]]; then
    success "Transactional message already exists: \"${NAME}\" (id: ${EXISTING_ID})"
    return
  fi

  HTML=$(render_template_html "$TEMPLATE_NAME" 2>/dev/null || echo "")
  if [[ -z "$HTML" ]]; then
    warn "Could not render template ${TEMPLATE_NAME} — skipping transactional message creation"
    return
  fi

  PAYLOAD=$(python3 -c "
import json, sys
payload = {
    'transactional_message': {
        'name': sys.argv[1],
        'subject': sys.argv[2],
        'body': sys.argv[3],
        'from': 'hello@shogo.ai',
        'reply_to': 'hello@shogo.ai',
        'msg_type': 'email'
    }
}
print(json.dumps(payload))
" "$NAME" "$SUBJECT" "$HTML")

  RESULT=$(cio_post "/transactional_messages" "$PAYLOAD")
  ID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('transactional_message',{}).get('id',''))" 2>/dev/null || echo "")
  if [[ -n "$ID" ]]; then
    success "Created transactional message: \"${NAME}\" (id: ${ID})"
  else
    warn "Could not create transactional message for ${NAME} (may already exist or HTML too large)"
  fi
}

# Drip emails
create_transactional_message \
  "drip-welcome" \
  "Welcome to Shogo — your first agent is one message away" \
  "drip-welcome"

create_transactional_message \
  "drip-quick-win" \
  "Start here: the Research Assistant takes 2 minutes" \
  "drip-quick-win"

create_transactional_message \
  "drip-stuck-nudge" \
  "Most people get stuck at this exact step" \
  "drip-stuck-nudge"

create_transactional_message \
  "drip-first-action" \
  "Your agent is configured — now talk to it" \
  "drip-first-action"

create_transactional_message \
  "drip-social-proof" \
  "What a 3-person startup is doing with Shogo" \
  "drip-social-proof"

create_transactional_message \
  "drip-re-engagement" \
  "{{agentName}} hasn't heard from you yet" \
  "drip-re-engagement"

create_transactional_message \
  "drip-power-up" \
  "Your agent just did something useful — here's the next level" \
  "drip-power-up"

create_transactional_message \
  "drip-heartbeat" \
  "Your agent can work while you sleep" \
  "drip-heartbeat"

# Conversion emails
create_transactional_message \
  "conversion-usage-limit" \
  "You've used up your Shogo session — here's what happens next" \
  "conversion-usage-limit"

create_transactional_message \
  "conversion-power-user" \
  "You're in the top tier of Shogo free users" \
  "conversion-power-user"

create_transactional_message \
  "conversion-win-back" \
  "{{agentName}} hasn't heard from you in a week" \
  "conversion-win-back"

# ─── Workflow configuration (UI only) ─────────────────────────────────────────

heading "Step 5: Workflow setup (≈5 min in the UI)"

echo ""
info "All campaigns and segments are live. The final step is to:"
info "open each campaign's workflow editor and wire the trigger → email steps → exit."
echo ""
echo -e "${BOLD}The workflow trigger configuration requires the UI — there is no programmatic API for it.${NC}"
echo ""

# ─── Campaign A: Onboarding Drip ──────────────────────────────────────────────

echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}CAMPAIGN A — Onboarding Drip (id: ${CAMP_A})${NC}"
link "${UI_BASE}/campaigns/${CAMP_A}/workflow/edit"
echo ""
cat <<STEPS_A
  Trigger:  Event — "signup"
  Exit on:  User enters segment "Free Users" becomes false (i.e. plan becomes pro)

  Workflow steps to add in order:

  1. [E1] Send Email immediately
       Template: drip-welcome
       Subject:  "Welcome to Shogo — your first agent is one message away"
       A/B alt:  "You're in — build your first AI agent in 5 minutes"

  2. [Wait] 1 day

  3. [Filter] Has NOT received event "project_created"?
     └─ YES → [E2] Send Email
               Template: drip-quick-win
               Subject:  "Start here: the Research Assistant takes 2 minutes"
               A/B alt:  "Pick your first agent (2 min setup, no config required)"

  4. [Wait] 2 more days (3 days total)

  5. [Filter] Has NOT received event "project_created"?
     └─ YES → [E3] Send Email
               Template: drip-stuck-nudge
               Subject:  "Most people get stuck at this exact step"

  6. [Wait] 2 more days (5 days total)

  7. [E5] Send Email
       Template: drip-social-proof
       Subject:  "What a 3-person startup is doing with Shogo"

  8. [Wait] 2 more days (7 days total)

  9. [Filter] Has NOT received event "chat_message_sent"?
     └─ YES → [E6] Send Email
               Template: drip-re-engagement
               Subject:  "{{customer.first_name}}'s agent hasn't heard from you yet"

  10. [Wait] 3 more days (10 days total)

  11. [Filter] HAS received "chat_message_sent" AND NOT "first_heartbeat_scheduled"?
      └─ YES → [E8] Send Email
                Template: drip-heartbeat
                Subject:  "Your agent can work while you sleep"

  NOTE: E4 (drip-first-action) and E7 (drip-power-up) are triggered by events,
  not time. Add them as separate event-triggered campaigns OR as in-workflow
  branches triggered when "project_created" / "chat_message_sent" is received.

STEPS_A

# ─── Campaign C1: Usage Limit ──────────────────────────────────────────────────

echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}CAMPAIGN C1 — Conversion: Usage Limit Hit (id: ${CAMP_C1})${NC}"
link "${UI_BASE}/campaigns/${CAMP_C1}/workflow/edit"
echo ""
cat <<STEPS_C1
  Trigger:  Event — "usage_limit_hit"
  Re-entry: Allow — wait 5 days before re-entering (prevents spam)
  Exit on:  User enters "Free Users" segment becomes false

  Workflow steps:
  1. [E] Send Email immediately
       Template: conversion-usage-limit
       Subject:  "You've used up your Shogo session — here's what happens next"
       A/B alt:  "Your usage window reset — and here's how to never hit it again"

STEPS_C1

# ─── Campaign C2: Power User ───────────────────────────────────────────────────

echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}CAMPAIGN C2 — Conversion: Power User Recognition (id: ${CAMP_C2})${NC}"
link "${UI_BASE}/campaigns/${CAMP_C2}/workflow/edit"
echo ""
cat <<STEPS_C2
  Trigger:  Segment — "Power Users (Free)" (id: ${SEG_POWER}) — enter once
  Exit on:  User leaves "Free Users" segment (plan becomes pro)

  Workflow steps:
  1. [Wait] 48 hours after entering segment
  2. [E] Send Email
       Template: conversion-power-user
       Subject:  "You're in the top tier of Shogo free users"
       A/B alt:  "You've sent {{customer.chat_message_count}} messages. Here's the next step."

STEPS_C2

# ─── Campaign C3: Win-Back ─────────────────────────────────────────────────────

echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}CAMPAIGN C3 — Win-Back: Inactive Users (id: ${CAMP_C3})${NC}"
link "${UI_BASE}/campaigns/${CAMP_C3}/workflow/edit"
echo ""
cat <<STEPS_C3
  Trigger:  Segment — "Inactive Free Users" (id: ${SEG_INACTIVE}) — enter on re-qualify
  Exit on:  User receives any event (re-engagement) OR leaves "Free Users" segment

  Workflow steps:
  1. [E] Send Email immediately on trigger
       Template: conversion-win-back
       Subject:  "{{customer.first_name}}'s agent hasn't heard from you in a week"

STEPS_C3

# ─── Suppression ──────────────────────────────────────────────────────────────

echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}SUPPRESSION${NC}"
echo ""
cat <<SUPP
  Suppression is handled in code:
    - customerioService.suppressUser() is called when Stripe reports a plan upgrade
    - This removes the user from all free-user campaigns immediately

  Optional UI safety net:
    Settings > Suppression > Add rule:
      audience = "Free Users" (id: ${SEG_FREE}) becomes false → suppress from:
        - Campaign A (${CAMP_A}), C1 (${CAMP_C1}), C2 (${CAMP_C2}), C3 (${CAMP_C3})

SUPP

# ─── A/B test setup ───────────────────────────────────────────────────────────

echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}A/B SUBJECT LINE TESTS${NC}"
echo ""
cat <<ABTEST
  In each campaign's workflow editor, click the email action > "Split test":

  [E1] drip-welcome
    A: "Welcome to Shogo — your first agent is one message away"
    B: "You're in — build your first AI agent in 5 minutes"

  [E2] drip-quick-win
    A: "Start here: the Research Assistant takes 2 minutes"
    B: "Pick your first agent (2 min setup, no config required)"

  [C1] conversion-usage-limit
    A: "You've used up your Shogo session — here's what happens next"
    B: "Your usage window reset — and here's how to never hit it again"

  [C2] conversion-power-user
    A: "You're in the top tier of Shogo free users"
    B: "You've sent {{customer.chat_message_count}} messages. Here's the next step."

  Set auto-winner after 7 days based on unique click rate (50/50 split).

ABTEST

# ─── Events schema ────────────────────────────────────────────────────────────

heading "Events fired by Shogo → Customer.io"

cat <<EVENTS

  Event name                        Fired in
  ─────────────────────────────────────────────────────────────────────────
  signup                            apps/api/src/auth.ts
  project_created                   apps/api/src/services/marketplace-install.service.ts
  chat_message_sent                 apps/api/src/routes/project-chat.ts
  usage_limit_hit                   apps/api/src/routes/project-chat.ts
  first_heartbeat_scheduled         apps/api/src/routes/internal.ts

  User traits set on identify:
    email, name, plan ("free" | "pro"), created_at

EVENTS

echo ""
success "Setup complete!"
echo ""
info "Campaigns:  ${UI_BASE}/campaigns"
info "Segments:   ${UI_BASE}/segments"
info "Messages:   ${UI_BASE}/transactional_messages"
echo ""
info "Run again at any time — this script is idempotent."
