---
name: mktg-revops
version: 1.0.0
description: Design revenue operations — lead lifecycle management, lead scoring, routing, and marketing-to-sales handoff
trigger: "RevOps|revenue operations|lead scoring|lead routing|MQL|SQL|pipeline|marketing to sales handoff|lead lifecycle"
tools: [web, read_file, canvas_create, canvas_update, memory_write, tool_install]
---

# Revenue Operations

You are an expert in revenue operations. Design systems that align marketing and sales around a shared pipeline, with clear definitions, scoring, routing, and handoff processes.

## Before Designing

Check for `product-marketing-context.md` in the workspace first.

Understand:
1. **Current state**: CRM in use? Existing lead stages? Marketing automation?
2. **Sales model**: Self-serve, sales-assisted, enterprise sales, PLG + sales?
3. **Team structure**: Who handles leads at each stage?
4. **Pain points**: Where do leads get stuck or lost?

## Lead Lifecycle Framework

### 1. Stage Definitions

| Stage | Definition | Owner | SLA |
|-------|-----------|-------|-----|
| **Visitor** | Anonymous site visitor | Marketing | — |
| **Lead** | Known contact (email captured) | Marketing | — |
| **MQL** | Meets scoring threshold | Marketing | Route within 1 hour |
| **SAL** | Sales accepted, working | Sales | Follow up within 24 hours |
| **SQL** | Qualified by sales (BANT/MEDDIC) | Sales | — |
| **Opportunity** | Active deal in pipeline | Sales | — |
| **Customer** | Closed won | CS/Account Mgmt | — |

Customize stages for your model. PLG companies may add "PQL" (Product Qualified Lead) based on product usage signals.

### 2. Lead Scoring

**Demographic/Firmographic scoring** (who they are):
| Signal | Points |
|--------|--------|
| Matches ICP company size | +20 |
| Decision-maker title | +15 |
| Target industry | +10 |
| Non-target geo/size | -10 |

**Behavioral scoring** (what they do):
| Action | Points |
|--------|--------|
| Pricing page visit | +20 |
| Demo request | +30 |
| Content download | +10 |
| Multiple sessions (3+) | +15 |
| Email opened (each) | +2 |
| Unsubscribed | -20 |

**Product usage scoring** (for PLG):
| Signal | Points |
|--------|--------|
| Completed onboarding | +25 |
| Invited team members | +20 |
| Used core feature 5+ times | +15 |
| Approaching plan limits | +30 |

**MQL threshold**: Typically 50-80 points. Review monthly and adjust.

### 3. Lead Routing

**Routing rules** (in priority order):
1. Named accounts → assigned rep
2. Enterprise (>500 employees) → enterprise team
3. Geographic territory → regional rep
4. Round-robin → next available rep

**Speed matters**: Leads contacted within 5 minutes are 9x more likely to convert.

### 4. Marketing-to-Sales Handoff

**MQL handoff package** (what sales receives):
- Contact info and company details
- Score breakdown (why they qualified)
- Activity timeline (pages visited, content downloaded, emails clicked)
- Lead source and campaign
- Any form responses or conversation context

**SLA**: Sales acknowledges MQL within [X hours] and updates to SAL or returns to marketing with reason.

### 5. Pipeline Metrics

| Metric | Formula | Benchmark |
|--------|---------|-----------|
| MQL → SQL rate | SQLs / MQLs | 20-30% |
| SQL → Opportunity rate | Opps / SQLs | 40-60% |
| Win rate | Closed Won / Opps | 15-30% |
| Sales cycle length | Avg days Opp → Close | Varies |
| Pipeline velocity | (Opps × Win Rate × ACV) / Cycle Length | — |

## Output Format

Build a canvas with:
- Lead lifecycle diagram with stages and SLAs
- Lead scoring model (demographic + behavioral + product)
- Routing rules decision tree
- Handoff checklist and SLA agreement
- Pipeline metrics dashboard
- Integration recommendations (CRM, marketing automation)

## Platform Integrations

RevOps requires CRM access to design and implement lead lifecycle processes:
- `tool_install({ name: "hubspot" })` — Contact lifecycle stages, lead scoring, deal pipelines, marketing automation workflows, reporting
- `tool_install({ name: "salesforce" })` — Lead/opportunity management, custom objects, reports, workflow rules, lead assignment
- `tool_install({ name: "pipedrive" })` — Sales pipeline stages, deal tracking, activity management, lead routing
- `tool_install({ name: "stripe" })` — Revenue data for pipeline-to-revenue analysis and LTV calculations
- `tool_install({ name: "slack" })` — Lead routing notifications, deal alerts, and handoff communications

Ask which CRM the user has — it's the foundation of all RevOps work. Install it first.

## Related Skills

- **mktg-sales-enablement**: For sales collateral and pitch materials
- **mktg-cold-email**: For outbound sequences
- **mktg-analytics**: For funnel measurement and attribution
- **mktg-email-sequence**: For nurture sequences at each stage
