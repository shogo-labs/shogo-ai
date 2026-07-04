---
name: business-intake
version: 1.0.0
description: Collect a local business's REAL details in one pass, then fill the site — so nothing is ever invented
trigger: "build my website|restaurant site|cafe website|make a website|set up my site|paste your details|business details"
tools: [edit_file, read_file, memory_write]
---

# Business Intake — "paste your real details"

The goal: gather the owner's real information **before** writing any content, so
you fill `src/data/site-content.ts` once with true details instead of guessing
and correcting. Never invent values to "get started" — collect, then build.

## Step 1 — Ask for everything at once

Send ONE friendly message with a fill-in-the-blanks block the owner can paste
back. Make it obvious that blanks are fine.

> Great — I'll build your site. Paste back whatever you have (leave blanks if
> you're not sure; we can add them later):
>
> - **Business name:**
> - **One-line tagline:**
> - **Type:** (restaurant / cafe / bakery / bar / other)
> - **Short "about" (1–3 sentences):**
> - **Phone:**
> - **Email:**
> - **Address:**
> - **Opening hours** (per day, or "same every day"):
> - **Menu** (sections + items + prices — paste your existing menu, a photo, a
>   link, or a doc and I'll structure it):
> - **Photos:** (attach/upload or paste image links — I won't use stock photos)
> - **Take bookings?** (yes/no, plus any deposit or large-party note)
> - **Social links:** (Instagram, Facebook, Google Maps…)

If they upload a menu photo, PDF, or link, read it and extract items/prices
faithfully. If a price or item is unclear, ask — do not guess.

## Step 2 — Confirm anything ambiguous

Only ask follow-ups for things that are genuinely unclear (an unreadable price,
a missing day's hours). Don't interrogate — one short round of clarification.

## Step 3 — Fill the content file in a single edit

Edit `src/data/site-content.ts`:
- Set `business`, `contact`, `hours`, `menu.categories`, `gallery`,
  `booking`, and `social` from what the owner gave you.
- Keep the currency and wording the owner used (e.g. "£9.50", "₹320", "$14").
- For hours, fill each day's `hours` string; leave it `""` for closed days.
- Only add gallery entries with real, working image URLs (owner uploads/links).
- Flip `configured: true` **only once** name + a contact method + real hours
  are present. Until then, leave it false so the setup banner stays up.

## Step 4 — Show the preview and hand over control

- Point the owner at the live preview and walk through each section.
- Tell them how to change things later: "just say 'update our Sunday hours' or
  'add a new special' and I'll edit it."
- Offer next steps: add photos, connect Slack/Gmail/Calendar for bookings,
  then publish.

## Guardrails (repeat of the one rule)

- Blank > wrong. An empty menu or gallery is fine; a fabricated one is not.
- No stock/placeholder images, no invented dishes, prices, hours, or awards.
- Save durable facts (name, address, hours) with `memory_write` so you stay
  consistent across sessions.
