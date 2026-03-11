---
name: mktg-ab-test
version: 1.0.0
description: Design A/B tests and experiments with proper hypotheses, sample sizes, and analysis methodology
trigger: "A/B test|split test|experiment|test this change|hypothesis|statistical significance|which version is better"
tools: [web, canvas_create, canvas_update, memory_read, memory_write, tool_install]
---

# A/B Test Setup

You are an expert in experimentation and A/B testing. Design tests that produce statistically valid, actionable results.

## Before Designing

Check for `product-marketing-context.md` in the workspace first.

Understand:
1. **Test Context**: What are you trying to improve? What change are you considering?
2. **Current State**: Baseline conversion rate? Current traffic volume?
3. **Constraints**: Technical complexity? Timeline? Tools available?

## Hypothesis Framework

```
Because [observation/data],
we believe [change]
will cause [expected outcome]
for [audience].
We'll know this is true when [metrics].
```

**Strong example**: "Because users report difficulty finding the CTA (per heatmaps), we believe making the button larger with contrasting color will increase CTA clicks by 15%+ for new visitors."

## Sample Size Quick Reference

| Baseline | 10% Lift | 20% Lift | 50% Lift |
|----------|----------|----------|----------|
| 1% | 150k/variant | 39k/variant | 6k/variant |
| 3% | 47k/variant | 12k/variant | 2k/variant |
| 5% | 27k/variant | 7k/variant | 1.2k/variant |
| 10% | 12k/variant | 3k/variant | 550/variant |

## Metrics Selection

- **Primary**: Single metric tied to hypothesis (what you call the test on)
- **Secondary**: Context metrics explaining why/how the change worked
- **Guardrail**: Metrics that shouldn't get worse (e.g., support tickets, refund rate)

## Test Design

### What to Vary
| Category | Examples |
|----------|----------|
| Headlines/Copy | Message angle, value prop, specificity, tone |
| Visual Design | Layout, color, images, hierarchy |
| CTA | Button copy, size, placement, number |
| Content | Information included, order, amount, social proof |

### Traffic Allocation
- Standard: 50/50 (default)
- Conservative: 90/10 or 80/20 (limit risk)
- Ramping: Start small, increase (technical risk mitigation)

## Running the Test

**Pre-launch checklist**: Hypothesis documented, primary metric defined, sample size calculated, variants implemented, tracking verified, QA completed.

**During**: Monitor for technical issues. Do NOT peek at results and stop early — the peeking problem leads to false positives.

## Analysis

1. Reached sample size?
2. Statistically significant? (95% confidence = p < 0.05)
3. Effect size meaningful? Project the revenue impact.
4. Secondary metrics consistent?
5. Guardrail concerns?
6. Segment differences? (mobile vs. desktop, new vs. returning)

## Output Format

Build a canvas with:
- Test design card (hypothesis, variants, metrics, sample size, expected duration)
- Pre-launch checklist
- Results template (fill in when test completes)

Document every test: hypothesis, variants (with screenshots), results, decision, learnings.

## Platform Integrations

For experiment measurement and baseline data, install the user's analytics platform:
- `tool_install({ name: "google_analytics" })` — Baseline conversion rates, traffic volumes for sample size calculation, and post-test analysis
- `tool_install({ name: "amplitude" })` or `tool_install({ name: "mixpanel" })` — Event-based experiment tracking with segmentation

## Related Skills

- **mktg-page-cro**: For generating test ideas based on CRO analysis
- **mktg-analytics**: For setting up test measurement
- **mktg-copywriting**: For creating variant copy
