---
name: stripe-checkout
version: 2.0.0
description: Switch on the store's real Stripe payments — the hosted-checkout route already ships; this wires the owner's key and verifies it
trigger: "connect stripe|take payments|enable checkout|start selling|accept cards|set up payments|stripe key"
tools: [edit_file, read_file, run_command]
---

# Switch on Stripe checkout

The checkout route **already ships** in this project at `custom-routes.ts`
(`POST /api/checkout` + a `POST /api/webhooks/stripe`). It uses **Stripe Hosted
Checkout** (a redirect), NOT Stripe Elements — do not swap in
`@stripe/react-stripe-js`; the "Elements context" / network errors come from
that path. You do NOT need to write the route. You only need to give it the
owner's key and verify it. If you must change server logic, edit
`custom-routes.ts` (never `server.tsx`, which is generated).

## Step 1 — Put the owner's Stripe secret key in the environment

- Ask for their Stripe **secret key**: `sk_test_…` to trial, `sk_live_…` for
  real charges. It's THEIR Stripe account — that's where the money lands.
- Store it as **`STRIPE_SECRET_KEY`** in the project environment (the
  env/secret store). Never put it in source or the client bundle.
- If they paste it in chat, tell them once that it's now in the transcript and
  to rotate it after setup; then never echo it again. If they already gave it
  to you earlier, USE it — don't re-ask.

That's the only required step. With the key set, `/api/checkout` returns a real
Stripe URL and the storefront's Checkout button starts working.

## Step 2 — Verify before telling the owner it works

A green build only proves it compiled. Hit the endpoint with a real product id
from `src/data/store-content.ts`:

```sh
curl -s -w "\nHTTP %{http_code}\n" -X POST \
  http://localhost:$RUNTIME_PORT/api/checkout \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"id":"<a-real-product-id>","quantity":1}]}'
```

Expect `{"ok":true,"url":"https://checkout.stripe.com/..."}`.
- `stripe_not_configured` → the key isn't in the env yet (Step 1).
- `stripe_error` → read the message; usually a bad key or a test-vs-live
  mismatch.

Then add a product to the cart in the preview and click Checkout — you should
land on Stripe's page and, after a test payment, return to `?checkout=success`.

## Step 3 (recommended) — Mark orders paid via webhook

The webhook route also already ships (`POST /api/webhooks/stripe`). To activate:
- In the Stripe dashboard → Developers → Webhooks → add endpoint
  `https://<published-domain>/api/webhooks/stripe`, event
  `checkout.session.completed`.
- Put the signing secret in the env as **`STRIPE_WEBHOOK_SECRET`**.

Without the webhook, checkout still works and the cart clears on the success
redirect; orders just stay `pending` in the DB instead of flipping to `paid`.

## Reading orders
- "Show me today's orders" → `GET /api/orders?status=paid` and summarize.
- Orders hold customer contact details — keep them private; never render the
  order list on the public storefront.

## Guardrails
- The route re-reads authoritative prices from `store-content.ts` — never trust
  prices from the browser. Keep it that way if you edit the route.
- NEVER log or echo `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`.
- Use `sk_test_…` while trialling; switch to `sk_live_…` only once the owner has
  confirmed the flow end-to-end.
