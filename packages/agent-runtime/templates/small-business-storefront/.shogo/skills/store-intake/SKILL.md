---
name: store-intake
version: 1.0.0
description: Collect a shop's REAL products and details in one pass, then fill the catalog — so nothing is ever invented
trigger: "build my store|online shop|sell products|set up my store|add my products|paste your products|storefront"
tools: [edit_file, read_file, memory_write]
---

# Store Intake — "paste your real products"

Goal: gather the owner's real store details and products **before** writing any
catalog, so you fill `src/data/store-content.ts` once with true data instead of
guessing and correcting. Never invent products or prices to "get started".

## Step 1 — Ask for everything at once

Send ONE friendly message with a fill-in-the-blanks block. Make blanks OK.

> Great — I'll build your store. Paste back whatever you have (leave blanks if
> you're not sure; we can add them later):
>
> - **Store name:**
> - **One-line tagline:**
> - **Short "about" (1–3 sentences):**
> - **Currency:** (e.g. USD, GBP, EUR, INR)
> - **Products** — for each: name, price, a short description, a photo
>   (upload/link), and a category if you group them. Paste a list, a
>   spreadsheet, or a link and I'll structure it.
> - **Shipping/collection note:** (e.g. "Free UK shipping over £30", "Local
>   pickup only")
> - **Contact email:**
> - **Social links / website:**

If they upload a product list (CSV, photos, a link), read it and extract names
and prices faithfully. If a price is unclear, ASK — do not guess.

## Step 2 — Convert prices to minor units

Every price goes in as an INTEGER of minor units in `priceMinor`:
- £9.50 → `950`, $14 → `1400`, €19.99 → `1999`, ₹320 → `32000`.
Set `store.currency` (lowercase ISO: "usd"/"gbp"/"eur"/"inr") and
`store.currencySymbol` (e.g. "$"/"£"/"₹") to match. Getting this wrong charges
the wrong amount, so double-check.

## Step 3 — Fill the catalog in a single edit

Edit `src/data/store-content.ts`:
- Fill `store`, `contact`, `shippingNote`, `products`, `social`.
- Give each product a stable, human `id` (slug), e.g. `"house-blend-250g"`.
- Only add a product `image` if it's a real, working URL the owner gave you.
- Use `available: false` for out-of-stock items (they stay visible, not buyable).
- Flip `configured: true` **only once** the store has a name and ≥1 real product.

## Step 4 — Preview, then offer payments

- Point the owner at the live preview; add products to the cart to show the flow.
- Explain that the cart works now, and checkout switches on once they connect
  Stripe → offer to run the **`stripe-checkout`** skill next.
- Tell them how to change things later ("say 'add a new product' or 'change the
  price of X' and I'll edit it").

## Guardrails
- Blank > wrong. An empty catalog is fine; a fabricated one is not.
- No stock/placeholder images, no invented products, prices, or claims.
- Save durable facts (store name, currency) with `memory_write`.
