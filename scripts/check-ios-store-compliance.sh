#!/usr/bin/env bash
# Pre-build sanity check for App Store-critical wiring.
# This script MUST pass before any iOS binary is uploaded to App Store Connect.
# Add this as a required step in .github/workflows/ios.yml and in pre-push hooks.
#
# What it guards:
#   1. Sign in with Apple is wired on iOS in sign-in.tsx
#      (Guideline 4.8 — first rejection cause d7d85854)
#   2. AppleContinueButton is rendered by MobileLoginPanel & DesktopFormPanel
#   3. Bundle identifier is ai.shogo.app (not com.odin.ai)
#   4. All IAP product IDs in iap.ts use the ai.shogo.app.* prefix
#      (Guideline 2.1(b) — third rejection cause)
#   5. Apple IAP service in apps/api uses matching product IDs
#
# Exit code: 0 = OK, 1 = compliance failure (block the release).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
RESET=$'\033[0m'

FAILURES=0

check() {
  local label="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    echo "${GREEN}✓${RESET} $label"
  else
    echo "${RED}✗${RESET} $label"
    FAILURES=$((FAILURES + 1))
  fi
}

echo ""
echo "═══ iOS App Store compliance pre-flight ═══"
echo ""

# ────────────────────────────────────────────────────────────────
# Guideline 4.8 — Sign in with Apple
# ────────────────────────────────────────────────────────────────
echo "▶ Guideline 4.8 — Sign in with Apple"

SIGN_IN_FILE="apps/mobile/app/(auth)/sign-in.tsx"
if [ -f "$SIGN_IN_FILE" ] && grep -q "Platform.OS === 'ios' ? handleAppleSignIn" "$SIGN_IN_FILE"; then
  check "sign-in.tsx passes onAppleSignIn unconditionally on iOS" 0
else
  check "sign-in.tsx passes onAppleSignIn unconditionally on iOS — Apple button WILL be missing in build" 1
fi

LOGIN_SCREEN="packages/shared-ui/src/screens/LoginScreen.tsx"
if grep -q "AppleContinueButton" "$LOGIN_SCREEN"; then
  count=$(grep -c "AppleContinueButton onPress={onAppleSignIn}" "$LOGIN_SCREEN" || true)
  if [ "$count" -ge 2 ]; then
    check "AppleContinueButton rendered in both MobileLoginPanel AND DesktopFormPanel (count=$count)" 0
  else
    check "AppleContinueButton render-site count must be >=2 (mobile + desktop panels), found $count" 1
  fi
else
  check "AppleContinueButton component missing from LoginScreen.tsx" 1
fi

# ────────────────────────────────────────────────────────────────
# Bundle identifier
# ────────────────────────────────────────────────────────────────
echo ""
echo "▶ Bundle identifier (ai.shogo.app)"

APP_JSON="apps/mobile/app.json"
if grep -q '"bundleIdentifier": *"ai.shogo.app"' "$APP_JSON"; then
  check "apps/mobile/app.json bundleIdentifier = ai.shogo.app" 0
else
  current=$(grep bundleIdentifier "$APP_JSON" | head -1 | sed 's/.*: *//;s/[",]//g' | xargs)
  check "Bundle id must be ai.shogo.app — currently: $current" 1
fi

if grep -rn "com\.odin\.ai" apps/mobile/ apps/api/src/ packages/ --include="*.ts" --include="*.tsx" --include="*.json" --include="*.yml" 2>/dev/null | grep -v node_modules | grep -v "/dist/" | grep -v "ios/Pods" | grep -v "package-lock" | grep -qv "^$"; then
  found=$(grep -rln "com\.odin\.ai" apps/mobile/ apps/api/src/ packages/ --include="*.ts" --include="*.tsx" --include="*.json" --include="*.yml" 2>/dev/null | grep -v node_modules | grep -v "/dist/" | head -3 | tr '\n' ' ')
  check "Legacy com.odin.ai references must be removed — found in: $found" 1
else
  check "No legacy com.odin.ai references in source" 0
fi

# ────────────────────────────────────────────────────────────────
# Guideline 2.1(b) — IAP product IDs aligned to bundle
# ────────────────────────────────────────────────────────────────
echo ""
echo "▶ Guideline 2.1(b) — IAP product IDs"

IAP_FILE="apps/mobile/lib/iap.ts"
if [ -f "$IAP_FILE" ]; then
  bad=$(grep -oE "'ai\.shogo\.(basic|pro|business|enterprise)\.(monthly|annual)'" "$IAP_FILE" 2>/dev/null | grep -v "ai\.shogo\.app\." | head -3 || true)
  if [ -z "$bad" ]; then
    check "apps/mobile/lib/iap.ts uses ai.shogo.app.* prefix for all product IDs" 0
  else
    check "Found stale IAP IDs without 'app.' prefix: $bad" 1
  fi

  required_ids=("ai.shogo.app.basic.monthly" "ai.shogo.app.basic.annual" "ai.shogo.app.pro.monthly" "ai.shogo.app.pro.annual" "ai.shogo.app.business.monthly" "ai.shogo.app.business.annual")
  missing=""
  for id in "${required_ids[@]}"; do
    if ! grep -q "$id" "$IAP_FILE"; then
      missing="$missing $id"
    fi
  done
  if [ -z "$missing" ]; then
    check "All 6 ASC-registered subscription IDs present in iap.ts" 0
  else
    check "Missing IAP product IDs in iap.ts:$missing" 1
  fi
fi

API_IAP="apps/api/src/services/apple-iap.service.ts"
if [ -f "$API_IAP" ]; then
  if grep -qE "'ai\.shogo\.app\.(basic|pro|business)\.(monthly|annual)'" "$API_IAP"; then
    check "apps/api/src/services/apple-iap.service.ts has ai.shogo.app.* product IDs" 0
  else
    check "API service missing ai.shogo.app.* product IDs (server cannot validate receipts)" 1
  fi
fi

# ────────────────────────────────────────────────────────────────
# Apple Authentication entitlement
# ────────────────────────────────────────────────────────────────
echo ""
echo "▶ iOS entitlements"

if [ -f "$APP_JSON" ] && grep -q "expo-apple-authentication" "$APP_JSON"; then
  check "expo-apple-authentication plugin enabled in app.json" 0
elif [ -f "apps/mobile/package.json" ] && grep -q '"expo-apple-authentication"' apps/mobile/package.json; then
  check "expo-apple-authentication package installed" 0
else
  check "expo-apple-authentication not installed — Apple button will throw at runtime" 1
fi

# ────────────────────────────────────────────────────────────────
echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "${RED}${FAILURES} compliance check(s) failed.${RESET}"
  echo "${RED}Do NOT upload this binary to App Store Connect — Apple will reject it.${RESET}"
  echo ""
  exit 1
fi

echo "${GREEN}All App Store compliance checks passed.${RESET}"
echo "${YELLOW}Reminder:${RESET} compliance is also a runtime concern."
echo "Test the sign-in screen on a real iPad before submitting — verify both 'Continue with Apple' and 'Continue with Google' render."
echo ""
exit 0
