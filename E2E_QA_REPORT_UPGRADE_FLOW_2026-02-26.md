# E2E QA Report — Upgrade Flow (Free → Pro)

**Date:** February 26, 2026  
**Environment:** studio-staging.shogo.ai  
**Browser:** Playwright-controlled Chromium  
**Tester:** Automated QA via Cursor Agent  
**Test Duration:** ~12 minutes end-to-end  
**Test Account:** qa-upgrade-test-feb26@mailnull.com  
**Workspace ID:** d8231047-ee43-4c16-abab-2973f3544eaa

---

## Executive Summary

Tested the full sign-up → upgrade flow on staging: new account creation, failed payment handling, successful Pro subscription, and post-upgrade feature verification. The billing backend (Stripe webhooks, credit allocation, credit deduction) works correctly. However, **the Advanced model is always locked on the project page** due to missing billing data propagation to the ChatPanel component — the primary Pro feature gate is broken on the web app.

| Category | Rating | Notes |
|----------|--------|-------|
| Sign-up flow | **PASS** | Instant, clean, redirects to dashboard |
| Stripe checkout (failed card) | **PASS** | Clear error message, stays on form to retry |
| Stripe checkout (successful) | **PASS** | Payment processed, redirect back in ~5s |
| Billing page (plan update) | **PASS** | Correctly shows "You're on Pro Plan" |
| Billing page (credit tracking) | **PASS** | Credits update accurately (104.60 of 105 after 2 interactions) |
| Sidebar (Upgrade CTA removal) | **PASS** | "Upgrade to Pro" correctly hidden for Pro users |
| Advanced model gating | **FAIL** | Always shows "Upgrade to unlock" — even for Pro users |
| Project header "Upgrade" button | **FAIL** | Always visible, even for Pro users |
| "Manage" subscription button | **FAIL** | No-op — doesn't open Stripe customer portal |
| Credit deduction (backend) | **PASS** | 0.2 credits per interaction, properly tracked |
| Canvas rendering | **PARTIAL** | Works during build, but blank on page reload |
| Welcome email | **FAIL** | `nodemailer` package missing from build |

**Overall Grade: B-** (billing backend solid, but key frontend gating is broken)

---

## Detailed Timing Log

### Phase 1: Sign-Up (T+0:00 → T+0:08)

| Step | Time | Status | Notes |
|------|------|--------|-------|
| App load (studio-staging.shogo.ai) | ~3s | PASS | Loaded into previous session (QA Retest Feb23) |
| Sign-out | ~1s | PASS | Redirected to /sign-in cleanly |
| Switch to Sign Up tab | Instant | PASS | Form swapped immediately |
| Fill form (Name, Email, Password) | <1s | PASS | All fields accept input correctly |
| Password strength indicator | Instant | PASS | Shows "Strong" for 16-char password |
| Sign-up submission | ~1s | PASS | Account created, redirected to home dashboard |
| Workspace auto-created | Instant | PASS | "Upgrade QA Personal" workspace created |

**UX Notes:**
- Clean sign-in/sign-up tab interface with "Shogo AI Studio" branding
- Password visibility toggle and strength indicator work well
- Previous session email/password is pre-filled by browser autofill (minor: could confuse users trying to create new accounts)
- Personalized greeting: "What's on your mind, Upgrade?" — uses first name from registration

### Phase 2: Pre-Upgrade State (T+0:08 → T+0:15)

| Observation | Value | Notes |
|-------------|-------|-------|
| Sidebar CTA | "Upgrade to Pro" / "Unlock more benefits" | Correctly shown for Free users |
| Billing page — Plan | "You're on Free Plan" | Correct |
| Billing page — Credits | 55 of 55 | Standard free tier allocation |
| Billing page — Rollover | "No credits will rollover" | Correct for Free plan |
| Daily credits note | "Daily credits reset at midnight UTC" | Present |
| Plan cards | Pro ($25/mo), Business ($560/mo), Enterprise (Custom) | All visible |
| Monthly/Annual toggle | Present | Annual shows "Save ~17%" badge |

### Phase 3: Failed Card Attempt (T+0:15 → T+0:40)

| Step | Time | Status | Notes |
|------|------|--------|-------|
| Click "Upgrade to Pro" | ~2s | PASS | Navigates to /billing, then Stripe Checkout page |
| Stripe Checkout load | ~3s | PASS | "Subscribe to Pro" — $25.00/month |
| Email pre-filled | Instant | PASS | From signup data |
| Country defaulted | Instant | PASS | United States auto-selected |
| Enter declining card (4000 0000 0000 0002) | <2s | PASS | Card number formatted: "4000 0000 0000 0002" |
| Fill expiration + CVC + name + ZIP | <2s | PASS | All fields work |
| "Save my information" checkbox | Default: checked | NOTE | Requires phone number when checked — validation catches it |
| Uncheck "Save my information" | Instant | PASS | Phone number requirement removed |
| Click "Subscribe" | ~3s | PASS | Button shows "Processing..." with spinner |
| Decline error displayed | ~3s | PASS | **"Your credit card was declined. Try paying with a debit card instead."** |
| Form stays active | Instant | PASS | User can edit card and retry without leaving page |

**UX Notes:**
- Stripe Checkout page is clean and professional with "Shogo AI sandbox" branding + Sandbox badge
- "Pay with Link" option available at top
- Decline error is clearly displayed in red text below card input
- All form fields remain populated after decline — good for retry UX
- One console error logged (the /confirm endpoint 4xx) — not user-visible
- **Minor issue**: The "Save my information" checkbox is checked by default, requiring a phone number. Users who skip the phone field will get a validation error that may be confusing — the validation jumps to the phone field

### Phase 4: Successful Payment (T+0:40 → T+0:50)

| Step | Time | Status | Notes |
|------|------|--------|-------|
| Clear card → Enter 4242 4242 4242 4242 | <2s | PASS | Visa icon appears |
| Click "Subscribe" | Instant | PASS | Button shows "Processing...", all fields disabled |
| Payment processing | ~3s | PASS | Stripe processes successfully |
| Redirect to app | ~2s | PASS | Returns to studio-staging.shogo.ai/ home page |
| **Total checkout → redirect** | **~5s** | **PASS** | Fast, smooth experience |

**UX Notes:**
- No success toast or confirmation message on redirect — user just lands on home page
- The "Upgrade to Pro" button in the sidebar is immediately gone (no page refresh needed)
- No confetti, no "Welcome to Pro!" message — the transition is very subtle
- **Recommendation**: Add a brief success notification or welcome modal after upgrade

### Phase 5: Post-Upgrade Verification (T+0:50 → T+2:00)

#### Billing Page

| Check | Expected | Actual | Status |
|-------|----------|--------|--------|
| Plan name | "Pro Plan" | "You're on Pro Plan" | PASS |
| Credits | 100+ | "105 of 105" (100 monthly + 5 daily) | PASS |
| Rollover note | "Credits will rollover" | "Credits will rollover" | PASS |
| Pro card button | "Change Plan" (not "Upgrade") | "Change Plan" | PASS |
| Business card | "Upgrade to Business" | "Upgrade to Business" | PASS |
| "Manage" button | Opens Stripe portal | **No-op — nothing happens** | **FAIL** |

#### Sidebar

| Check | Expected | Actual | Status |
|-------|----------|--------|--------|
| "Upgrade to Pro" CTA | Hidden | Hidden | PASS |
| Credit count | Visible | **Not visible** | NOTE |

**UX Note**: The sidebar showed "5 credits left" on the Free plan, but after upgrading to Pro, no credit count is displayed in the sidebar. Pro users might want to see their remaining credits without navigating to the billing page.

#### Model Selector (Chat)

| Check | Expected | Actual | Status |
|-------|----------|--------|--------|
| Basic model | Available | Available: "Fast responses, 4x cheaper (~0.2 credits)" | PASS |
| Advanced model | Unlocked for Pro | **"Upgrade to unlock"** — shows PRO badge but still locked | **FAIL** |
| Clicking "Advanced" | Selects advanced model | **Redirects to /billing** | **FAIL** |

#### Project Header

| Check | Expected | Actual | Status |
|-------|----------|--------|--------|
| "Upgrade" button | Hidden for Pro | **Still visible** | **FAIL** |

### Phase 6: Agent Interaction & Credit Tracking (T+2:00 → T+6:00)

#### First Interaction: Task Tracker Build

| Step | Time | Status | Notes |
|------|------|--------|-------|
| Enter prompt | Instant | PASS | "Build a simple task tracker to test the upgrade" |
| Project auto-named | ~1s | PASS | "Task Tracker Test" |
| Agent response start | ~2s | PASS | Plan outlined, then building |
| Canvas creation + schema + seed + query | ~10s | PASS | 4 tool calls |
| UI build (canvas_update x2) | ~5s | PASS | Self-corrected Text component props |
| Self-testing (inspect + trigger_action x4) | ~10s | PASS | Add, Complete, Delete all verified |
| **Total first response** | **~30s** | **PASS** | Complete task tracker with 3 items |

**Backend log**: `Charged 0.2 credits (2632 tokens across 13 requests, model: haiku) — remaining: 104.8`

#### Second Interaction: Priority Update

| Step | Time | Status | Notes |
|------|------|--------|-------|
| Enter request | Instant | PASS | "Add a priority column and color code the tasks" |
| Agent response start | ~2s | PASS | Outlined plan |
| Canvas rebuild (schema cleared, recreated) | ~15s | PASS | Full rebuild with priority dropdown |
| Self-testing | ~5s | PASS | All 3 actions verified |
| **Total second response** | **~25s** | **PASS** | Priority dropdown + badges added |

**Backend log**: `Charged 0.2 credits (3011 tokens across 14 requests, model: haiku) — remaining: 104.6`

#### Credit Tracking Summary

| Surface | Before Upgrade | After Upgrade | After 1st Chat | After 2nd Chat |
|---------|---------------|---------------|----------------|----------------|
| Billing page | 55 of 55 | 105 of 105 | 104.80 of 105 | 104.60 of 105 |
| Backend (K8s logs) | N/A | 105 allocated | 104.8 remaining | 104.6 remaining |
| Sidebar | "5 credits left" (prev acct) | Not displayed | Not displayed | Not displayed |

**Verdict**: Credit tracking is **accurate and consistent** between billing page and backend. Each Basic-mode interaction costs 0.2 credits.

### Phase 7: Canvas Rendering (T+6:00 → T+8:00)

| Scenario | Status | Notes |
|----------|--------|-------|
| Canvas during agent build | PASS | Renders live as agent creates it |
| Canvas after page reload | **FAIL** | Shows "Connected" + "The canvas will appear..." but does NOT render the existing canvas |
| Canvas after second build (same session) | PASS | Renders correctly with priority badges |

**BUG**: After navigating away from the project and returning (or page reload), the canvas shows the "Connected" status message but does not render the previously-built UI. The agent's canvas output is only visible during the session when it's created.

---

## Backend & Infrastructure

**Cluster:** shogo-staging (us-east-1)  
**API Pod:** `api-00467-deployment-78fccc5cf-7hzkw`  
**Project Pod:** `project-029b8ba7-0bab-45a6-b5e4-afa8aa33a135-00001-deploymq4dbj`

### Stripe Webhook Processing

```
[Webhook] Received event: customer.subscription.created
[Webhook] Subscription event: {
  type: "customer.subscription.created",
  subscriptionId: "sub_1T58APAp5PDuxitpUuuWDqZq",
}
[Webhook] Received event: checkout.session.completed
[Webhook] Checkout completed: {
  subscriptionId: "sub_1T58APAp5PDuxitpUuuWDqZq",
  planId: "pro",
  billingInterval: "monthly",
}
[Webhook] Subscription created + credits allocated for workspace: d8231047-ee43-4c16-abab-2973f3544eaa plan: pro
```

**Verdict**: Webhook processing is **fast and reliable**. Both `customer.subscription.created` and `checkout.session.completed` events processed successfully.

### Billing Sessions

| Interaction | Tokens | Requests | Credits Charged | Model | Remaining |
|------------|--------|----------|----------------|-------|-----------|
| 1st (task tracker build) | 2,632 | 13 | 0.2 | haiku | 104.8 |
| 2nd (priority update) | 3,011 | 14 | 0.2 | haiku | 104.6 |

### Infrastructure Health

- All pods Running (2/2 containers ready)
- No OOM kills or crash loops
- S3 sync: Downloaded 13 files in 558ms (0 errors)
- ~30 warm pool agents running, normal lifecycle

### Errors Found in Logs

| # | Error | Severity | Details |
|---|-------|----------|---------|
| 1 | Welcome email failed | Medium | `Cannot find package 'nodemailer' from '/app/packages/sdk/dist/email/server.js'` |

---

## Bugs & Issues Summary

### Critical

| # | Issue | Impact | Root Cause | Fix Location |
|---|-------|--------|------------|--------------|
| 1 | **Advanced model always locked for Pro users** | High — The primary Pro feature gate is broken. Pro users cannot use the Advanced model. | `apps/mobile/app/(app)/projects/[id]/_layout.tsx` does not pass `billingData` to `ChatPanel`. The `billingData` prop is optional and defaults to `hasActiveSubscription: false`. | Pass `useBillingData(workspaceId)` result as `billingData` prop to `ChatPanel` in the project layout. |

### Medium

| # | Issue | Impact | Details |
|---|-------|--------|---------|
| 2 | **"Manage" button non-functional** | Medium — Pro users cannot manage their subscription (cancel, update card, view invoices) through the Stripe customer portal. | Clicking "Manage" on the billing page triggers no API call and has no visible effect. |
| 3 | **"Upgrade" button always visible in project header** | Medium — Confuses Pro users into thinking they need to upgrade further. | `ProjectTopBar.tsx` always renders the "Upgrade" button with no subscription check. Should be hidden when `isPaidPlan` is true, or changed to "Plan" for Pro users. |
| 4 | **Canvas blank on page reload** | Medium — After navigating away and back, the canvas shows "Connected" but doesn't render the previously-built UI. | The canvas state may not be persisting or reloading correctly on navigation. |
| 5 | **Welcome email fails** | Medium — New users don't receive a welcome email. | `nodemailer` package is missing from the deployed build (`/app/packages/sdk/dist/email/server.js`). |

### Low

| # | Issue | Impact | Details |
|---|-------|--------|---------|
| 6 | **No success notification after upgrade** | Low — Users have no confirmation that their upgrade succeeded beyond the subtle removal of the "Upgrade to Pro" sidebar button. | Add a toast/banner "Welcome to Pro!" or similar after Stripe redirect. |
| 7 | **No credit count in sidebar for Pro users** | Low — Free users see "X credits left" in the sidebar, but Pro users see nothing. | The sidebar CTA is hidden for Pro users, but the credit balance is only shown as part of that CTA block. Consider showing credits separately. |
| 8 | **"Save my info" checkbox default** | Low — Checked by default, requires phone number. Users who skip phone get a confusing validation error. | Consider defaulting to unchecked, or making phone field visible/required from the start. |
| 9 | **favicon.ico 404** | Low — Console error for missing favicon. | Add a favicon to the staging deployment. |

---

## UX Highlights (Positive)

1. **Clean billing page** — Clear plan comparison with feature lists, credit counts, and monthly/annual toggle
2. **Stripe Checkout** — Professional, fast, correctly branded as "Shogo AI sandbox"
3. **Decline handling** — Clear error message, form stays populated for retry
4. **Fast upgrade redirect** — ~5s from payment to landing on dashboard
5. **Accurate credit tracking** — Billing page matches backend logs exactly
6. **Sidebar CTA removal** — Instantly updates after upgrade (no refresh needed)
7. **Daily credits breakdown** — "Daily credits used first" + rollover info is helpful
8. **Credit cost transparency** — "~0.2 credits" shown next to model name in selector

---

## UX Issues (Negative)

1. **Silent upgrade success** — No toast, banner, or modal confirming the upgrade
2. **Confusing "Upgrade to unlock" on Pro plan** — Users who just paid $25 see their paid feature locked
3. **"Upgrade" button everywhere** — Project header shows "Upgrade" even on Pro plan
4. **Credit visibility inconsistency** — Credits shown on billing page but not in sidebar for Pro users
5. **Canvas reload blank** — Previously-built canvas doesn't render on page reload
6. **"Manage" button dead** — Pro users have no way to manage their subscription from the app

---

## Performance Summary

| Metric | Value | Rating |
|--------|-------|--------|
| App initial load | ~3s | Good |
| Sign-up completion | ~1s | Excellent |
| Stripe Checkout load | ~3s | Good |
| Failed card error display | ~3s | Good |
| Successful payment → redirect | ~5s | Good |
| Billing page credit update | Accurate on page load | Good |
| First agent response (task tracker) | ~30s | Good |
| Second agent response (priority update) | ~25s | Good |
| Credit cost per Basic interaction | 0.2 credits | Expected |
| Tab switching | <100ms | Excellent |

---

## Recommendations

### Critical (Fix Before Launch)
1. **Pass billing data to ChatPanel** — In `apps/mobile/app/(app)/projects/[id]/_layout.tsx`, import `useBillingData` and pass it as the `billingData` prop to `ChatPanel`. This will unlock the Advanced model for Pro users.
2. **Implement "Manage" button** — Wire up the Stripe customer portal session creation API so Pro users can manage their subscription.

### High Priority
3. **Conditionally hide project header "Upgrade" button** — In `ProjectTopBar.tsx`, check `isPaidPlan` and hide/change the button for Pro users.
4. **Add upgrade success notification** — Show a toast or welcome modal after Stripe redirect with `?checkout=success` query parameter.
5. **Fix canvas persistence on reload** — Ensure the canvas re-renders when navigating back to a project.

### Medium Priority
6. **Fix welcome email** — Add `nodemailer` to the deployment dependencies.
7. **Show credits in sidebar for Pro users** — Display credit balance separate from the Upgrade CTA.
8. **Default "Save my information" to unchecked** — Or make phone number field always visible when checked.

### Low Priority
9. **Add favicon** — Fix the 404 console error.
10. **Consider upgrade celebration** — Confetti, animation, or a brief welcome-to-Pro onboarding.

---

## Credit Tracking Audit

| Location | Displays Credits? | Accurate? | Notes |
|----------|------------------|-----------|-------|
| Billing page (main) | Yes — "104.60 of 105" | Yes | Matches backend exactly |
| Billing page (plan card) | Yes — "100 credits / month" | Yes | Static, describes plan |
| Sidebar (Free plan) | Yes — "X credits left" | Yes | Shows in Upgrade CTA block |
| Sidebar (Pro plan) | **No** | N/A | CTA hidden, credits hidden with it |
| Model selector | Yes — "~0.2 credits" | Yes | Shows cost per interaction |
| K8s logs | Yes — "remaining: 104.6" | Yes | Source of truth |
| Project header | No | N/A | No credit display |
| Chat panel | No | N/A | No credit display during/after interaction |

**Verdict**: Credits are tracked accurately in the backend and displayed correctly on the billing page. The main gap is sidebar visibility for Pro users and the lack of real-time credit feedback in the chat panel.

---

*Report generated: February 26, 2026*  
*Project URL: https://studio-staging.shogo.ai/projects/029b8ba7-0bab-45a6-b5e4-afa8aa33a135*
