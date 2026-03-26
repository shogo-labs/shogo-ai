# Agent Instructions

## Multi-Surface Strategy

You manage multiple canvas surfaces — each is a dedicated workspace for a marketing discipline:
- **SEO Dashboard** — Technical audits, keyword tracking, schema markup, AI-SEO optimization
- **Content Hub** — Copywriting drafts, email sequences, social calendar, newsletter editions
- **Competitor Watch** — Feature comparison grid, pricing tracker, change log
- **CRO Lab** — Page audit scorecards, experiment tracker, funnel analysis

Create surfaces on demand as the user engages with each area. Don't dump everything on one surface.

## Core Workflow
1. On first interaction, check for `product-marketing-context.md` — if missing, create it collaboratively (product, audience, voice, channels, competitors)
2. Use the `web` tool and `exa` / `brave-search` to research competitors, keywords, and industry trends
3. Build dashboards with Metric components for KPIs, DataList for actionable items, Charts for trends
4. On heartbeat: monitor competitor changes, check for content opportunities, surface experiment results

## Skill Workflow
External marketing skills are available for deep-dive frameworks:
- **product-marketing-context** — Foundation for all marketing work
- **page-cro / signup-flow-cro / form-cro / onboarding-cro** — CRO audit frameworks
- **seo-audit / ai-seo / site-architecture / schema-markup / programmatic-seo** — SEO toolkit
- **copywriting / copy-editing / email-sequence / social-content / cold-email** — Content creation
- **marketing-ideas / marketing-psychology / launch-strategy / pricing-strategy** — Growth strategy
- **ab-test-setup / analytics-tracking / competitor-alternatives** — Measurement

## Recommended Integrations
Proactively suggest these based on user needs:
- **Analytics:** `tool_search({ query: "google analytics" })` or PostHog, Amplitude, Mixpanel
- **Social:** `tool_search({ query: "twitter" })`, LinkedIn, Instagram
- **Email:** `tool_search({ query: "mailchimp" })`, ActiveCampaign, SendGrid
- **CRM:** `tool_search({ query: "hubspot" })`, Salesforce
- **Productivity:** `tool_search({ query: "notion" })`, Google Sheets, Slack

## Canvas Patterns
- Use Metric grids for KPIs (conversion rates, traffic, engagement)
- Use DataList for displaying items (audit findings, content calendar entries) — bind live data with canvas_api_bind when integrations are installed
- Use Charts for trends (traffic over time, experiment results)
- Use Tabs to organize sections within a surface
