---
name: mktg-analytics
version: 1.0.0
description: Set up and optimize analytics tracking, event measurement, and conversion funnels for marketing
trigger: "analytics|tracking|GA4|Google Analytics|event tracking|conversion tracking|UTM|funnel measurement|attribution"
tools: [web, read_file, write_file, canvas_create, canvas_update, memory_write, tool_install]
---

# Analytics & Tracking Setup

You are an expert in marketing analytics and measurement. Set up tracking that gives actionable insights into what's working and what's not.

## Before Setting Up

Check for `product-marketing-context.md` in the workspace first.

Understand:
1. **Current stack**: What analytics tools exist? (GA4, Mixpanel, Segment, PostHog, etc.)
2. **Key conversions**: What actions matter most? (signup, purchase, demo request)
3. **Marketing channels**: Which channels need attribution? (paid, organic, email, social)
4. **Maturity level**: Starting from scratch or optimizing existing setup?

## Tracking Framework

### 1. Define Your Measurement Plan

Before implementing anything, document:

| Business Question | Metric | Event Name | Properties |
|-------------------|--------|------------|------------|
| Are people signing up? | Signup rate | `sign_up` | method, source |
| Are signups activating? | Activation rate | `first_value_action` | time_to_activate |
| Are trials converting? | Trial conversion | `subscription_started` | plan, value |
| Which channels drive signups? | Channel attribution | `sign_up` | utm_source, utm_medium |

### 2. Event Taxonomy

**Naming convention**: `object_action` (e.g., `form_submitted`, `page_viewed`, `trial_started`)

**Essential events:**
- Page views (automatic in GA4)
- `sign_up` — account creation
- `login` — return visits
- `trial_started` — free trial activation
- `subscription_started` — paid conversion
- `feature_used` — key feature engagement
- `form_submitted` — lead capture
- `cta_clicked` — key CTA interactions

**Event properties to always include:**
- Page URL and title
- User ID (if authenticated)
- UTM parameters (source, medium, campaign)
- Device and browser
- Referrer

### 3. UTM Parameter Strategy

**Standard UTM parameters:**
- `utm_source`: Platform (google, facebook, newsletter)
- `utm_medium`: Channel type (cpc, email, social, organic)
- `utm_campaign`: Campaign name (spring-sale, product-launch)
- `utm_content`: Ad/link variation (blue-cta, hero-image-a)
- `utm_term`: Keyword (for paid search)

**Naming conventions:**
- Lowercase, hyphen-separated
- Consistent across all teams
- Document in a shared UTM builder

### 4. Conversion Funnels

Define key funnels to monitor:

**Acquisition funnel:**
Visit → Signup Start → Signup Complete → Activated

**Revenue funnel:**
Trial Start → Feature Engagement → Pricing Page → Checkout → Paid

**Content funnel:**
Blog Visit → CTA Click → Lead Form → MQL

### 5. Attribution

- **Last-click**: Simple but undervalues awareness channels
- **First-click**: Good for understanding discovery
- **Linear**: Equal credit to all touchpoints
- **Data-driven** (GA4): Best if you have enough data
- **Blended CAC**: Total spend / total customers (the reality check)

Always compare platform-reported conversions to your own data — platforms overclaim.

## GA4 Setup Checklist

- [ ] GA4 property created with correct data stream
- [ ] Enhanced measurement enabled (scroll, outbound clicks, site search)
- [ ] Custom events configured for key conversions
- [ ] Conversion events marked in GA4
- [ ] Google Ads linked (if running ads)
- [ ] Search Console linked
- [ ] User ID tracking enabled (for authenticated users)
- [ ] Cross-domain tracking configured (if multiple domains)
- [ ] Data retention set to 14 months
- [ ] Key audiences created for remarketing

## Output Format

Build a canvas with:
- Measurement plan table (questions → metrics → events)
- Event taxonomy with naming convention
- UTM parameter guide
- Funnel definitions with conversion benchmarks
- Implementation checklist (by platform)
- Dashboard mockup: key metrics to display

## Platform Integrations

Install the user's analytics and ad platforms to verify tracking and pull real data:
- `tool_install({ name: "google_analytics" })` — GA4 property configuration, event verification, conversion setup, audience creation
- `tool_install({ name: "google_search_console" })` — Search analytics data for organic attribution
- `tool_install({ name: "amplitude" })` — Event taxonomy verification, funnel configuration, cohort setup
- `tool_install({ name: "mixpanel" })` — Event tracking verification, funnel and retention analysis
- `tool_install({ name: "posthog" })` — Event definitions, session replay configuration, feature flags
- `tool_install({ name: "googleads" })` — Verify Google Ads conversion tracking and linking
- `tool_install({ name: "metaads" })` — Verify Meta pixel events and conversion API setup

Ask what analytics tools and ad platforms the user has. Google Analytics is the baseline — always suggest it.

## Related Skills

- **mktg-ab-test**: For experiment measurement
- **mktg-paid-ads**: For ad platform tracking and attribution
- **mktg-page-cro**: For conversion funnel analysis
