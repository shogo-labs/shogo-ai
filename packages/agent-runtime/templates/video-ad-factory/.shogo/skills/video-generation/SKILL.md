---
name: video-generation
version: 2.0.0
description: Generate AI marketing videos and images with the built-in media tools (Higgsfield video + image, Genjutsu clip editing, fal fallbacks)
trigger: "generate video|create ad|make video|ugc|video ad|ai video|render video|product video|b-roll|talking head|creative asset|generate image|character sheet|influencer|restyle clip|swap object"
tools: [memory_read, memory_write, generate_image, generate_video, list_media_models, web]
---

# Video Generation

Generate AI marketing videos and images with the built-in media tools. No
external API key, no shell calls: `generate_image` and `generate_video` bill the
workspace directly, and `list_media_models` tells you what everything costs.

Higgsfield is the provider. fal models still work where Higgsfield has no
equivalent, and `list_media_models` marks them `deprecated`.

## Decision Tree — Which Model to Use

```
User goal?
├── Still image: product, editorial, lifestyle → hf-soul-v2 (default)
├── Still image with legible text (poster, logo) → hf-ideogram-4
├── Animating an approved still (image-to-video) → hf-hailuo-2.3
├── Draft / storyboard / b-roll (cheapest clip) → hf-hailuo-2.3 (default)
├── Fluid motion, polished hero shot → hf-kling-2.5-pro
├── Stylized look, up to 15 s → hf-wan-2.6
├── Needs an exact aspect_ratio in text-to-video, or audio → hf-ltx-2.5-fast
├── Edit an existing clip (motion, product swap, look) → Genjutsu (below)
└── Needs Veo / Nano Banana / FLUX / upscale → a fal model (deprecated, still works)
```

Run `list_media_models` at the start of any campaign: it returns the live list
with per-image and per-clip prices, plus each model's durations, aspect ratios
and resolutions. Never guess a model id.

## Genjutsu — editing a clip instead of generating one

Pass a workspace `.mp4` (4–30 s, ≤ 200 MB) as `source_video` and pick a
workflow with `genjutsu`:

| `genjutsu` | Use it for | Also needs |
| --- | --- | --- |
| `motion_transfer` | Drive a character/product photo with the motion of the clip | 1–8 reference images |
| `object_swap` | Replace an object in the clip with a product from a reference | 1–8 reference images (source ≥ 409,600 px/frame) |
| `restyle` | Change the look of the clip, keeping motion and audio | `preset_id` from `list_media_models` kind `"presets"` |

Genjutsu is priced per source second, so the price is only known once the clip
is submitted (`estimated_usd` on the submit response). Use `resolution: "480p"`
for drafts — restyle at 480p is about a fifth of 1080p.

## Execution Checklist

1. **Session folder** — Create `assets/YYYY-MM-DD_campaign-slug/` with subdirs: `video/`, `images/`, `audio/`, `scripts/`.
2. **Product** — Identify the product/offer from `MEMORY.md` catalog. If not in catalog, ask the user to describe it and persist it to memory.
3. **Script** — Write the ad script with beat structure:
   - Hook (2-3s): grab attention, pattern-interrupt
   - Show (3-5s): product reveal, first impression
   - Demo (3-5s): feature/benefit demonstration
   - CTA (2-3s): call to action, urgency
4. **Dialogue gate** — Present the full script to the user. **STOP HERE.** Do not proceed until the user approves. For non-speaking videos (b-roll, product shots), skip this step but still confirm the visual brief.
5. **Model choice** — Select from the decision tree. Explain the reasoning to the user.
6. **Cost estimate** — Get the real number, then show it:
   ```
   Plan: [N] clips @ [model] ([duration]) + [M] stills @ [model]
   Estimated cost: $[X]
   ```
   **MANDATORY.** Numbers come from `list_media_models` or from the
   `estimated_usd` that `generate_video` returns on submit — never from memory.
7. **Confirm** — Wait for explicit user approval ("go", "generate", "yes", etc.).
8. **Generate stills first** — `generate_image` for every shot's key frame. For a vertical ad, ask for a 9:16 still: the video inherits the frame from the start image.
9. **Animate** — `generate_video` with `start_image` pointing at the approved still. Poll (`wait: true`, or `job_id`) instead of re-submitting.
10. **QA** — When complete:
    - Video: lip-sync, warped faces/hands, flicker, audio/visual drift, brand marks
    - Images: extra limbs, distorted faces, gibberish text, impossible background geometry
11. **Present** — Add to the dashboard Assets tab with metadata (model, duration, price, QA status).

## Model Notes

| Model | Best for | Limits |
| --- | --- | --- |
| `hf-soul-v2` | Default stills: product, editorial, lifestyle | text-only; no reference images |
| `hf-ideogram-4` | Posters, logos, text in image | one style reference |
| `hf-hailuo-2.3` | Default clips, drafts, b-roll | 768p fixed, 6 or 10 s, no aspect_ratio |
| `hf-kling-2.5-pro` | Fluid motion, hero shots | 5 or 10 s, no aspect_ratio |
| `hf-wan-2.6` | Stylized/animated looks | 5/10/15 s, 720p or 1080p |
| `hf-ltx-2.5-fast` | Only text-to-video with `aspect_ratio`; audio | 6/8/10 s, 720p/1080p |
| `hf-genjutsu-*` | Editing a clip | source 4–30 s, ≤ 200 MB |

Hailuo, Kling and Wan take no `aspect_ratio`: output framing follows the start
image (or the model's fixed size). That is why a 9:16 ad starts from a portrait
still, not from an aspect_ratio argument.

## Script Length → Duration Table

| Words | Duration | Recommended model |
|-------|----------|-------------------|
| 5-15 | 6s | `hf-hailuo-2.3` |
| 15-25 | 6-10s | `hf-hailuo-2.3`, `hf-ltx-2.5-fast` |
| 25-37 | 10s | `hf-ltx-2.5-fast`, `hf-kling-2.5-pro` |
| 37-50 | 10-15s | `hf-wan-2.6` (15 s) |
| 50+ | Split into clips | Multiple shots, edited together |

Formula: ~2.5 words per second. Round up to the nearest duration the model supports.

## Image QA Rules

When reviewing generated images:
1. **Extra limbs** — Count fingers (5 per hand), arms (2), legs (2). Flag anomalies.
2. **Face distortion** — Check for asymmetry, melted features, double-eye artifacts.
3. **Text artifacts** — Embedded text must be legible or absent. No gibberish.
4. **Background consistency** — No impossible geometry, floating objects, merged elements.
5. **Brand alignment** — Does it match the visual language in `MEMORY.md`?

If issues are found:
- Retry 1: adjust the prompt to explicitly avoid the artifact ("exactly five fingers on each hand")
- Retry 2: change the model or the reference image
- After 2 retries: surface to the user with the issue and ask for guidance

## Cost Rules

- **Show the price before spending.** `generate_video` returns `estimated_usd` on submit; `list_media_models` gives per-image and per-clip prices.
- **Generate stills, not clips, while exploring the look.** A still is cents; a clip is tens of cents.
- **One clip per approved shot.** Re-running a clip costs the full clip price again.
- **Restyle at 480p** for drafts, then re-run the approved preset at 720p or 1080p.
- If the plan would cost more than the user approved, stop and ask.
