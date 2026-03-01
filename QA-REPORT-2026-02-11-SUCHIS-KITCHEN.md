# QA Report: Suchi's Kitchen - E2E Staging Test
**Date:** February 11, 2026  
**Environment:** studio-staging.shogo.ai  
**Tester:** Automated E2E via Cursor Agent  
**Project:** Suchi's Kitchen - Cloud Kitchen Business Planner  
**Project ID:** `9d834e5b-d02a-4efe-a070-f725ea14886c`

---

## Executive Summary

Created and tested a cloud kitchen business planning app ("Suchi's Kitchen") on the staging environment. The app successfully renders with a comprehensive UI for business planning in INR, but **data persistence is completely broken** due to a platform-level routing issue where API requests from the preview subdomain are served as static files instead of being proxied to the Hono backend server.

**Overall Status: PARTIAL PASS** — UI generation works well, but core CRUD functionality is non-functional.

---

## Test Timeline & Timing

| Step | Action | Time | Status |
|------|--------|------|--------|
| T+0s | Navigate to studio-staging.shogo.ai | ~3s initial load | ✅ |
| T+3s | Page fully loaded (already logged in as previous QA user) | <1s | ✅ |
| T+5s | Sign out | Instant | ✅ |
| T+6s | Sign-up page loaded | <1s | ✅ |
| T+8s | Fill sign-up form (Name, Email, Password) | ~2s | ✅ |
| T+10s | Submit sign-up | <1s (auto-login) | ✅ |
| T+11s | Dashboard loaded with personalized greeting | <1s | ✅ |
| T+15s | Entered project description in chat | ~3s | ✅ |
| T+18s | Project created, redirected to project page | Instant | ✅ |
| T+18-53s | Environment provisioning (Knative cold start) | ~35s | ⚠️ Slow |
| T+53s-3min | AI generating app (Round 1: 3/7 tasks completed) | ~2min | ⚠️ Incomplete |
| T+3-5min | AI generating (Round 2: fixing missing components) | ~2min | ✅ |
| T+5-8min | AI generating (Round 3: fixing API layer) | ~3min | ⚠️ Partial fix |
| T+8min | App preview rendered | - | ✅ UI Only |
| T+9min | Test data entry (Menu Item) | - | ❌ Save fails |
| T+10-12min | AI Round 3: fixing Prisma methods | ~2min | ⚠️ |
| T+12min | Rebuilt app, tested again | - | ❌ Still fails |

**Total Time: ~12 minutes from sign-up to functional (UI-only) app**

---

## Detailed Test Results

### 1. Sign-Up Flow ✅ PASS

**UX Rating: 8/10**

- Clean sign-in/sign-up tabbed interface
- Form fields: Name, Email, Password
- **Password strength indicator** — showed "Strong" immediately, nice UX feedback
- **Email validation** — visual checkmark appeared next to valid email
- **Progressive button enablement** — Sign Up button disabled until all fields filled
- Auto-login after sign-up (no email verification on staging - expected)
- Personalized greeting: "What's on your mind, Suchi?" appeared immediately
- **Minor:** `autocomplete` attribute warning in console for form inputs

**Account Created:**
- Name: Suchi Kitchen QA
- Email: suchi-kitchen-qa-20260211@shogo.ai

### 2. Dashboard / Home Page ✅ PASS

**UX Rating: 7/10**

- Clean layout with main chat input, suggestion buttons, and template gallery
- Suggestion chips: "Build a landing page", "Create a dashboard", "Design a form", "Make an API integration"
- Template gallery with 9 templates: Booking App, CRM, Expense Tracker, Expo App, Feedback Form, Form Builder, Inventory, Kanban, Todo App
- Template thumbnails load correctly
- **Note:** Console error on new account: `400 Bad Request` on `/api/workspaces` — likely expected for accounts with no workspaces

### 3. Project Creation ✅ PASS (UI), ⚠️ ISSUES (Backend)

**UX Rating: 6/10**

- Typing project description in the main input and pressing Enter creates project instantly
- Redirects to project page with chat session
- Environment provisioning takes **~35 seconds** (Knative cold start)
  - Shows "Starting your environment" with spinner
  - Shows "Configuration 'project-...' is waiting for a Revision to become ready"
  - Shows "Almost ready..." status

**AI Generation Issues:**

1. **Incomplete Generation (CRITICAL):** The AI stopped after completing only 3/7 tasks in the first round, leaving the app in a broken build state. Missing components caused `Could not resolve "./components/ProfitAnalysis"` build error.

2. **Required 3 rounds of prompting** to get the app to a working state:
   - Round 1: Created schema, Prisma client, Dashboard, MenuItems, FixedCosts (stopped at 3/7)
   - Round 2: Created remaining components, discovered TanStack Start import issue, created missing shogo.ts, fixed server routes
   - Round 3: Fixed Prisma API methods (list→findMany, create(data)→create({data}), etc.)

3. **Generated code had wrong Prisma API methods:** Used `list()`, `create(data)`, `update({id, data})`, `delete({id})` instead of `findMany()`, `create({data})`, `update({where:{id}, data})`, `delete({where:{id}})`

4. **Generated server-functions.ts imported `@tanstack/react-start`** which is not installed — the project uses Vite SPA, not TanStack Start

5. **Token usage was massive:** 4.57M total tokens (4.54M input, 27.8K output) for the first round alone

6. **Insufficient credits warning** appeared in API logs: `⚠️ Could not charge credits: Insufficient credits`

### 4. Generated App UI ✅ PASS

**UX Rating: 7/10**

The generated app has comprehensive features:

**Header:**
- "🍳 Suchi's Kitchen" title with "Cloud Kitchen Business Planner" subtitle
- Currency indicator: ₹ INR

**Navigation (6 tabs):**
1. 📊 Dashboard
2. 📋 Menu Items
3. 💰 Fixed Costs
4. 👥 Staff
5. 📈 Profit Analysis
6. ⚙️ Settings

**Dashboard Tab:**
- 4 summary cards: Projected Monthly Revenue, Total Monthly Costs, Net Monthly Profit, Break-even Time
- Cost Breakdown section (Variable, Fixed, Staff, Platform Commission, Delivery)
- Business Summary (Menu Items, Staff, Avg Order Value, etc.)
- Top Menu Items by Profit (empty state handled well)
- Quick Tips section with India-specific cloud kitchen advice (Swiggy/Zomato commissions)

**Menu Items Tab:**
- Add/remove form with fields: Item Name, Description, Category dropdown (Main Course, Appetizer, Dessert, Beverage, Sides, Combo)
- Cost fields: Ingredient Cost (₹), Preparation Cost (₹), Packaging Cost (₹)
- Selling Price (₹) and Estimated Monthly Orders
- **Real-time Profit Calculation** showing Total Cost, Profit per Unit, and Profit Margin as you type — excellent UX

**Fixed Costs Tab:**
- Add/remove fixed costs
- Total monthly summary
- Common fixed costs reference (Kitchen Rent, Electricity, Gas, FSSAI License, Insurance, etc.)

**Staff Management Tab:**
- Staff member management with role-based organization
- Summary cards: Total Staff, Monthly Salary, Avg. Salary
- Indian-specific salary ranges (Head Chef: ₹25-40K, Cook/Helper: ₹12-18K, etc.)
- Staffing tips section

**Profit Analysis Tab:**
- Monthly Revenue, Costs, Net Profit, Break-even cards
- Cost Breakdown with percentage
- **Scenario Analysis table**: Pessimistic (30% lower), Expected, Optimistic (30% higher), Best Case (50% higher)
- Key Insights with actionable recommendations

**Settings Tab:**
- Business configuration (name, type, start date)
- Platform & Delivery settings (commission %, delivery cost per order)
- Business Goals (target margin, revenue target)
- Comprehensive tips: Investment breakdown, Platform commissions (Swiggy/Zomato rates), Profit margin guidelines, Growth planning

**UX Issues Found:**
- No CSS styling loaded in the preview (basic HTML rendering, no Tailwind)
- NaN% display bug in Profit Analysis cost structure when no data exists
- All calculations show ₹0 because data can't be saved/loaded

### 5. Data Persistence ❌ FAIL (BLOCKING)

**This is the most critical issue.**

**Root Cause:** The project runtime's preview subdomain serves static files from `dist/`. When the client makes API calls (e.g., `fetch('/api/menuItem')`), the request hits the static file server which returns `index.html` (HTML) instead of routing to the Hono backend server. This causes `SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.

**Evidence from kube logs:**
```
[project-runtime] Subdomain: serving static api/menuItem from /app/project/dist/api/menuItem
```

The API call to `/api/menuItem` is being treated as a static file path, not routed to the Hono server's API handler.

**Impact:**
- Cannot add menu items (save fails)
- Cannot add fixed costs
- Cannot add staff members
- Cannot update settings
- Cannot load any persisted data
- All calculations show ₹0
- Dashboard is non-functional as a planning tool

**This is a platform-level architecture issue**, not an app code problem. The preview subdomain routing needs to support API proxying to the Hono backend server (or the project template needs to handle this differently).

### 6. Styling Issues ⚠️

The app appears to have Tailwind CSS classes in the markup but styles are not rendering properly in the preview. The app shows unstyled HTML with basic form elements. This could be related to:
- The `dist/` build including CSS but the preview not loading it properly
- Multiple Vite rebuilds causing stale CSS references

---

## Infrastructure Observations

### Kubernetes State (us-east-1, shogo-staging)

**System Pods:**
- `api-00332-deployment` — Running (latest revision)
- `studio-00297-deployment` — Running (latest revision)
- `docs-00031-deployment` — Running
- `platform-pg-2` / `projects-pg-2` — PostgreSQL pods running
- `image-prepuller` — 3 instances (1 still ContainerCreating)

**Workspace Pods:**
- `project-9d834e5b-...` — Running (our test project)
- `project-4e2cc75a-...` — Another project pod running
- `mcp-workspace-1-...` — MCP workspace running

**Project Runtime Logs:**
- Pod initialization: ~36 seconds (136 health checks before ready)
- Vite initial build: 17.1s (28 modules)
- Subsequent rebuilds: 2.7s - 10.8s
- Prisma db push: 195ms
- Prisma Studio started on port 5555
- **Error:** Prisma Studio proxy initially returned ConnectionRefused

### API Logs
- AI model used: Claude Sonnet 4.5 (primary) + Haiku 4.5 (secondary/validation)
- Multiple Anthropic API pass-through calls logged
- **Warning:** `Social provider google is missing clientId or clientSecret` on API startup
- **Warning:** `Could not charge credits: Insufficient credits` after first generation round

---

## Bugs & Issues Summary

| # | Severity | Issue | Category |
|---|----------|-------|----------|
| 1 | **P0** | API calls from preview return HTML instead of JSON — data cannot be saved/loaded | Platform Architecture |
| 2 | **P1** | AI generation stops prematurely at 3/7 tasks, requiring manual follow-up | AI Agent |
| 3 | **P1** | Generated server-functions.ts uses TanStack Start imports for Vite SPA project | Code Generation |
| 4 | **P1** | Generated Prisma API methods are incorrect (list() vs findMany(), etc.) | Code Generation |
| 5 | **P2** | NaN% displayed in Profit Analysis cost structure with empty data | App Bug |
| 6 | **P2** | Styling not fully rendering (Tailwind classes present but unstyled) | Preview/Build |
| 7 | **P2** | Token usage extremely high (4.57M tokens for one generation round) | Cost/Efficiency |
| 8 | **P3** | "Insufficient credits" warning — free tier limits reached quickly | Billing |
| 9 | **P3** | Environment provisioning takes ~35s (Knative cold start) | Performance |
| 10 | **P3** | Prisma Studio proxy error on first connection attempt | Infrastructure |
| 11 | **P3** | Google OAuth misconfigured on staging (missing clientId/clientSecret) | Configuration |
| 12 | **P3** | autocomplete attribute warning on sign-up form inputs | UI Polish |

---

## Recommendations

### Critical (P0)
1. **Fix preview subdomain API routing** — The preview subdomain must proxy `/api/*` requests to the Hono backend server rather than treating them as static file requests. This is the #1 blocker for any CRUD application.

### High Priority (P1)
2. **Improve AI generation reliability** — The AI should not stop mid-task leaving the app in a broken state. Consider:
   - Pre-checking that all referenced files exist before marking tasks complete
   - Adding a build verification step between task groups
   - Better handling of context window limits

3. **Fix code generation templates** — The generated server-functions.ts should match the project's framework (Vite SPA + Hono, not TanStack Start). The Prisma API method names should also be correct.

### Medium Priority (P2)
4. **Handle NaN/edge cases** in generated UI code when no data exists
5. **Ensure CSS/styling loads correctly** in preview
6. **Optimize token usage** — 4.57M tokens per generation round is extremely expensive

### Low Priority (P3)
7. Configure Google OAuth on staging
8. Reduce Knative cold start time
9. Fix Prisma Studio initial connection issue

---

## Positive Observations

1. **Sign-up flow is smooth** — Password strength indicator, email validation, and auto-login work well
2. **Project creation is instant** — URL routing, chat session creation all happen seamlessly
3. **AI understands the domain** — Generated India-specific content (Swiggy/Zomato commissions, INR pricing, Indian salary ranges)
4. **Real-time profit calculator** — The menu item form's live profit calculation is excellent UX
5. **Comprehensive feature set** — Dashboard, Menu Items, Fixed Costs, Staff, Profit Analysis, Settings with scenario planning
6. **Helpful tips and defaults** — Context-specific business advice for cloud kitchens in India
7. **Task progress tracking** — The AI shows clear task progression (0/7, 1/7, etc.)

---

## Test Artifacts

- Screenshots captured during testing:
  - `qa-staging-after-generation.png` — During AI generation
  - `qa-suchis-kitchen-dashboard.png` — Dashboard view
  - `qa-suchis-kitchen-fullview.png` — Full app view
  - `qa-suchis-kitchen-menu-items.png` — Menu Items form with data

---

*Report generated: February 11, 2026*
