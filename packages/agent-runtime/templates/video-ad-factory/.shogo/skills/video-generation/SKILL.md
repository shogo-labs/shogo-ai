---
name: video-generation
version: 1.0.0
description: Generate AI marketing videos and images using Arcads API (Sora 2, Veo 3.1, Kling 3.0, Seedance 2.0, Nano Banana)
trigger: "generate video|create ad|make video|ugc|video ad|ai video|render video|product video|b-roll|talking head|creative asset|generate image|character sheet|influencer"
tools: [canvas_create, canvas_update, memory_read, memory_write, web, browser, shell]
---

# Video Generation

Generate AI marketing videos and images via the Arcads API with full production workflow.

## Decision Tree — Which Model to Use

```
User goal?
├── UGC / talking-head / influencer → Seedance 2.0
├── Product hero / premium reveal → Seedance 2.0
├── Feature walkthrough / demo → Seedance 2.0
├── Studio lookbook / lifestyle → Seedance 2.0
├── Long-form text-to-video (>10s) → Sora 2 (up to 20s)
├── Image-to-video / start-frame continuity → Veo 3.1 (up to 8s)
├── B-roll / atmospheric scenes → Kling 3.0 (up to 5s)
└── Still images / character sheets → Nano Banana
```

## Execution Checklist

1. **Session folder** — Create `assets/YYYY-MM-DD_campaign-slug/` with subdirs: `video/`, `images/`, `audio/`, `scripts/`.
2. **Product** — Identify the product/offer from `MEMORY.md` catalog. If not in catalog, ask user to describe it and persist to memory.
3. **Script** — Write the ad script with beat structure:
   - Hook (2-3s): grab attention, pattern-interrupt
   - Show (3-5s): product reveal, first impression
   - Demo (3-5s): feature/benefit demonstration
   - CTA (2-3s): call to action, urgency
4. **Dialogue gate** — Present full script to user. **STOP HERE.** Do not proceed until user approves. For non-speaking videos (b-roll, product shots), skip this step but still confirm the visual brief.
5. **Model choice** — Select based on decision tree above. Explain reasoning to user.
6. **Credit estimate** — Calculate cost and display:
   ```
   Model: [model name]
   Duration: [Xs]
   Estimated credits: [N]
   Remaining balance: [M] credits
   ```
   **MANDATORY.** Never skip this step.
7. **Confirm** — Wait for explicit user approval ("go", "generate", "yes", etc.)
8. **Generate** — Submit request to Arcads API via shell or custom route.
9. **Poll** — Check generation status every 30s. Update dashboard with progress indicator.
10. **QA** — When complete:
    - Video: check for lip-sync issues, visual glitches, audio/visual misalignment
    - Images: check for extra limbs, distorted faces, text artifacts, background inconsistencies
11. **Present** — Add to dashboard Assets tab with metadata (model, duration, credits, QA status).

## Model-Specific Notes

### Seedance 2.0
- Best for: UGC talking-head, product hero, premium reveal, feature walkthrough, studio lookbook
- Max duration: 10s
- Requires: character reference image OR character sheet from Nano Banana
- Supports: lip-sync to audio, expression control
- Credit cost: ~3 credits per second

### Sora 2
- Best for: long-form text-to-video, cinematic shots, complex scenes
- Max duration: 20s
- Input: text prompt only (no start frame)
- Quality: highest visual fidelity for non-character content
- Credit cost: ~5 credits per second

### Veo 3.1
- Best for: image-to-video transitions, maintaining visual continuity from a reference frame
- Max duration: 8s
- Requires: start frame image (upload or generate with Nano Banana first)
- Supports: camera motion control
- Credit cost: ~4 credits per second

### Kling 3.0
- Best for: fast b-roll, atmospheric scenes, product environment shots
- Max duration: 5s
- Input: text prompt, optional reference image
- Fastest generation time of all video models
- Credit cost: ~2 credits per second

### Nano Banana
- Best for: still images, character sheets, product photography, reference frames for Veo 3.1
- Output: single high-resolution image
- Supports: style transfer, consistent character generation across shots
- Credit cost: ~1 credit per image

## Script Length → Duration Table

| Words | Duration | Recommended Model |
|-------|----------|-------------------|
| 5-15 | 2-6s | Kling 3.0, Seedance 2.0 |
| 15-25 | 6-10s | Seedance 2.0 |
| 25-37 | 10-15s | Sora 2 |
| 37-50 | 15-20s | Sora 2 |
| 50+ | Split into clips | Multiple models |

Formula: ~2.5 words per second. Round up to nearest model-supported duration.

## Image QA Rules

When reviewing generated images:
1. **Extra limbs check** — Count fingers (5 per hand), arms (2), legs (2). Flag anomalies.
2. **Face distortion** — Check for asymmetry, melted features, double-eye artifacts.
3. **Text artifacts** — Any embedded text should be legible or absent. No gibberish text.
4. **Background consistency** — No impossible geometry, floating objects, or merged elements.
5. **Brand alignment** — Does it match the brand's visual language from `MEMORY.md`?

If issues found:
- Retry 1: adjust prompt to explicitly avoid the artifact (e.g., "exactly five fingers on each hand")
- Retry 2: try different seed or slight prompt variation
- After 2 retries: surface to user with issue description and ask for guidance

## Credit Cost Estimation

**Always calculate before generating. Always show to user.**

```
Estimated cost:
  [N] × [model] clips @ [X] credits each = [total] credits
  + [M] images @ 1 credit each = [M] credits
  ────────────────────────────────────────
  Total: [grand total] credits
  Balance after: [remaining] credits
```

Never generate if remaining balance would drop below 10% without explicit override from user.
