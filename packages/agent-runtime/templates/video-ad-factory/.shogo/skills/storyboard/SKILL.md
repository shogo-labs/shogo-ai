---
name: storyboard
version: 1.0.0
description: Create structured video ad storyboards with beat-by-beat breakdown, model selection, and credit estimation
trigger: "storyboard|plan ad|script ad|ad concept|creative brief|ad structure|video plan|campaign concept|ad sequence"
tools: [canvas_create, canvas_update, memory_read, memory_write, web]
---

# Storyboard

Create structured video ad storyboards that map every beat to a generation model and credit cost.

## Workflow

1. **Understand product** — Read `MEMORY.md` for product catalog, brand voice, and past learnings. Ask what product/offer this ad is for if not clear.
2. **Identify hook** — Research competitor ads via `web` if needed. Determine the thumb-stop mechanism:
   - Pattern interrupt (unexpected visual)
   - Bold claim / controversy
   - Pain point callout
   - Curiosity gap
   - Before/after transformation
3. **Write script with beats** — Structure the ad into discrete beats, each with timing, visuals, audio, and on-screen text.
4. **Select model per beat** — Choose the optimal AI model for each beat based on content type.
5. **Estimate total credits** — Sum up all beats and present the full cost breakdown.
6. **Get approval** — Present the complete storyboard. Do NOT proceed to generation without explicit sign-off.
7. **Generate sequence** — Hand off approved beats to the `video-generation` skill one at a time.

## Beat Structure

Every short-form video ad follows this 4-beat framework:

### Beat 1: Hook (2-3 seconds)
- **Purpose:** Stop the scroll. Grab attention in the first frame.
- **Techniques:** Unexpected visual, bold text overlay, direct eye contact, loud audio cue.
- **Model choice:** Seedance 2.0 (if character), Kling 3.0 (if scene/b-roll), Nano Banana (if static frame).
- **Script:** 5-8 words max. Punchy, incomplete thought that demands continuation.

### Beat 2: Show (3-5 seconds)
- **Purpose:** Reveal the product. First visual impression.
- **Techniques:** Unboxing, product-in-hand, lifestyle context, premium reveal animation.
- **Model choice:** Seedance 2.0 (product hero), Veo 3.1 (if continuing from hook frame).
- **Script:** 8-12 words. Name the product, state the category or key differentiator.

### Beat 3: Demo (3-5 seconds)
- **Purpose:** Show the benefit or feature in action. Build belief.
- **Techniques:** Before/after, side-by-side, feature close-up, testimonial clip.
- **Model choice:** Seedance 2.0 (walkthrough), Sora 2 (complex scene), Kling 3.0 (quick cut b-roll).
- **Script:** 12-15 words. Explain the "why it works" or social proof.

### Beat 4: CTA (2-3 seconds)
- **Purpose:** Drive action. Create urgency.
- **Techniques:** Text overlay with offer, countdown, "link in bio", swipe-up prompt.
- **Model choice:** Nano Banana (static end card), Seedance 2.0 (speaking CTA).
- **Script:** 5-10 words. Clear instruction + urgency element.

## Storyboard Output Format

Present the storyboard as a structured table:

```
┌─────────────────────────────────────────────────────────────┐
│ STORYBOARD: [Campaign Name]                                  │
│ Product: [product]  |  Platform: [platform]  |  Total: [Xs]  │
├──────┬────────┬──────────────┬──────────┬────────┬──────────┤
│ Beat │ Time   │ Visual       │ Audio    │ Model  │ Credits  │
├──────┼────────┼──────────────┼──────────┼────────┼──────────┤
│ Hook │ 0-3s   │ [desc]       │ [desc]   │ [mod]  │ [N]      │
│ Show │ 3-7s   │ [desc]       │ [desc]   │ [mod]  │ [N]      │
│ Demo │ 7-12s  │ [desc]       │ [desc]   │ [mod]  │ [N]      │
│ CTA  │ 12-15s │ [desc]       │ [desc]   │ [mod]  │ [N]      │
├──────┴────────┴──────────────┴──────────┴────────┼──────────┤
│                                          TOTAL   │ [sum]    │
└──────────────────────────────────────────────────┴──────────┘
```

## Variant Strategy

For A/B testing, create 2-3 storyboard variants that differ in:
- **Hook variant:** Same product, different hook mechanism
- **Length variant:** 15s vs 30s vs 60s versions
- **Platform variant:** Vertical (TikTok/Reels) vs Square (Feed) vs Horizontal (YouTube)
- **Tone variant:** Aspirational vs. problem-aware vs. social-proof-led

Label each variant clearly and estimate total credits for the full test matrix.

## Campaign Learnings Integration

Before writing any storyboard:
1. Check `MEMORY.md` for past campaign performance data.
2. Identify which hook types performed best (highest thumb-stop rate).
3. Note which models produced the cleanest output for this product category.
4. Apply learnings — don't repeat hooks/angles that underperformed.
5. After results come in, persist new learnings back to `MEMORY.md`.
