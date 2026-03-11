---
name: mktg-context
version: 1.0.0
description: Create or update a product marketing context document — captures product, audience, positioning, and voice for all marketing skills
trigger: "product context|marketing context|set up context|positioning|target audience|describe my product|ICP|ideal customer"
tools: [read_file, write_file, memory_write]
---

# Product Marketing Context

Help users create and maintain `product-marketing-context.md` in the workspace. This captures foundational positioning and messaging that other marketing skills reference.

## Workflow

### Step 1: Check for Existing Context

Check if `product-marketing-context.md` exists in the workspace via `read_file`.

**If it exists:** Summarize what's captured, ask which sections to update.

**If it doesn't exist, offer two options:**
1. **Auto-draft from codebase** (recommended): Read README, landing pages, marketing copy, package.json — draft a V1 and iterate with the user.
2. **Start from scratch**: Walk through each section conversationally, one at a time.

### Step 2: Gather Information

Push for verbatim customer language — exact phrases are more valuable than polished descriptions.

**12 Sections to Capture:**

1. **Product Overview** — One-liner, what it does, category, type, business model/pricing
2. **Target Audience** — Company type, decision-makers, primary use case, jobs to be done
3. **Personas** (B2B) — User/Champion/Decision Maker/Buyer roles, what each cares about
4. **Problems & Pain Points** — Core challenge, why alternatives fail, cost, emotional tension
5. **Competitive Landscape** — Direct, secondary, indirect competitors and how each falls short
6. **Differentiation** — Key differentiators, how/why you solve it differently, why customers choose you
7. **Objections & Anti-Personas** — Top 3 objections with responses, who is NOT a good fit
8. **Switching Dynamics** (JTBD Four Forces) — Push, Pull, Habit, Anxiety
9. **Customer Language** — Verbatim problem/solution phrases, words to use/avoid, glossary
10. **Brand Voice** — Tone, communication style, personality (3-5 adjectives)
11. **Proof Points** — Key metrics, notable customers, testimonial snippets, value themes
12. **Goals** — Primary business goal, key conversion action, current metrics

### Step 3: Create the Document

Write `product-marketing-context.md` with structured markdown: tables for personas/objections/proof, bold field labels, blockquotes for testimonials.

### Step 4: Confirm and Save

Show the completed document, ask for adjustments, save via `write_file`. Tell the user other marketing skills will reference this automatically.

## Tips

- Ask "What's the #1 frustration that brings them to you?" not "What problem do they solve?"
- Capture exact customer words — they beat polished descriptions
- Ask for examples to unlock better answers
- Validate each section before moving on
- Skip sections that don't apply (e.g., Personas for B2C)

## Related Skills

- **mktg-copywriting**: Uses context for voice and messaging
- **mktg-page-cro**: Uses context for relevance and value prop analysis
- **mktg-paid-ads**: Uses context for audience targeting and ad copy
