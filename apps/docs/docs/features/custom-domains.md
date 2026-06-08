---
sidebar_position: 8
title: Custom Domains
slug: /features/custom-domains
---

# Custom Domains

When you publish a Shogo app, it goes live at a `your-app.shogo.one` address. With **custom domains** you can serve that same app from a domain you own — like `app.acme.com` — with a free SSL certificate that Shogo issues and renews for you automatically.

:::note
Custom domains aren't enabled on every plan or deployment. If you don't see the **Custom domain** option after publishing, it isn't available for your account yet — [reach out to support](/reference/support).
:::

## Before you start

You'll need:

- A **published** app — custom domains attach to an app that's already live.
- A domain you control, with access to its **DNS settings** at your registrar or DNS provider (for example Cloudflare, Namecheap, GoDaddy, or Route 53).

Just bring the domain itself — your root domain like `acme.com` is fine. You don't need to invent a subdomain. When you add a root domain, Shogo automatically sets up the `www` version too (and a redirect between them), so visitors reach your app either way.

## Step 1 — Publish your app

Custom domains point at a published app, so publish first:

1. Open your project.
2. Click **Publish** in the top bar.
3. Pick a subdomain (or keep the default), choose who can visit, and click **Publish**.

Your app is now live at `your-app.shogo.one`.

## Step 2 — Add your domain

You can manage custom domains from either place:

- **Publish dropdown** — click **Publish** and scroll down to the **Custom domain** section.
- **Project Settings** — open **Settings**, then go to **Publishing → Custom domain**.

Then:

1. Type your domain, e.g. `acme.com`.
2. Click **Add**.

Shogo registers `acme.com` **and** `www.acme.com` as a linked pair and shows you the DNS records to create. One of the two is the **primary** (canonical) address and the other redirects to it — `www` is primary by default. You can switch which one is primary anytime with **Make primary**.

## Step 3 — Create the DNS records

Shogo shows the records to add for each hostname at your DNS provider. Each record has a **Name** and a **Value** with a copy button. You'll usually see:

- A **CNAME** record — points your domain to your app.
- A **TXT** record — confirms you own the domain and verifies your SSL certificate.

Copy each value exactly and add it at your DNS provider. Where you do this varies by provider — look for a section called **DNS**, **Records**, or **Advanced DNS**.

:::tip
Copy the values straight from Shogo instead of typing them. A single wrong character will stop verification.
:::

## Step 4 — Wait for it to go live (automatic)

That's it — there's nothing else to click. Shogo checks your DNS and SSL automatically and your domain goes live on its own, usually within a few minutes of the records propagating. A small **timeline** shows exactly where things are — *Add records → Validate DNS → Issue certificate → Live* — and each DNS record shows a **Found / Not detected yet / Wrong target** tick so you can see at a glance which records are in place. The status moves through these stages:

| Status | What it means |
| --- | --- |
| **Awaiting DNS** | The records haven't been detected yet. Once you've added them, just wait. |
| **Validating DNS** | Your records were found and are being validated. |
| **Issuing certificate** | Validation passed; your SSL certificate is being issued (you'll see which certificate authority is issuing it). |
| **Live** | Your domain is active and serving your app over HTTPS. |
| **Taking longer than usual** | Your DNS looks correct but the certificate is taking a while (occasionally a certificate authority is slow). After about 30 minutes a **Retry certificate** button appears — see below. |
| **Action needed** | Something needs attention — read the message shown and fix it; we'll pick it up on the next check. |

Once the status is **Live**, open `https://acme.com` (or `https://www.acme.com`) and your app loads on your own domain, redirecting to whichever you chose as primary.

DNS changes can take anywhere from a few minutes to a few hours to take effect. There's a **Check now** button if you'd like to re-check immediately, but you don't have to — Shogo keeps checking in the background. SSL certificates are issued and renewed automatically.

### If it's taking longer than usual

Certificates are normally issued within a few minutes, but every so often the certificate authority is slow and a domain can sit in **Issuing certificate** longer than expected. When your DNS records are confirmed correct and it's been more than ~30 minutes, a **Retry certificate** button appears. Click it to nudge the certificate authority to try again — you don't need to change any DNS records. Shogo also retries automatically in the background, so the button is just there if you'd like to give it a push.

## Primary domain (www vs. root)

When you add a root domain we set up both `acme.com` and `www.acme.com`. One is the **primary** address visitors are redirected to; the other forwards to it with a permanent (308) redirect. Keeping a single primary address is good for SEO and avoids sign-in/OAuth issues from having two URLs.

By default `www.acme.com` is primary. To flip it, click **Make primary** next to the other hostname — the redirect direction switches right away.

## Using a different subdomain

You can also point a specific subdomain like `app.acme.com` or `docs.acme.com` at your app. Subdomains are added on their own (no automatic `www` pairing) and use a single CNAME record.

## Advanced: root domains and CNAME flattening

The root record Shogo gives you is a CNAME. Most DNS providers don't allow a plain CNAME at the root of a domain, but many — including **Cloudflare** and **Route 53** — support **CNAME flattening** (or **ALIAS**) records that make it work. If your provider supports that, the root domain works directly with the CNAME we provide. If it doesn't, simply use `www.acme.com` as your primary (the default), which always works.

## Remove a domain

To stop serving your app from a custom domain, open the **Custom domain** section and click the trash icon next to it. This removes both the root and `www` halves of the pair. You can add it back later if you change your mind.

## Troubleshooting

**Status stuck on "Awaiting DNS."** The records aren't visible to Shogo yet. Double-check that the Name and Value match exactly, confirm they're saved at your provider, and give DNS time to propagate — Shogo keeps checking automatically.

**Status shows "Action needed."** Read the message next to the domain. The most common causes are a typo in a record or a conflicting record already on the same name (such as an old A or CNAME record). Fix it at your provider; Shogo re-checks on its own.

**The page loads but shows a security warning.** Your SSL certificate is still being issued. Wait a few minutes after the records verify, then reload.

**Status says "Taking longer than usual."** Your DNS is correct but the certificate authority is slow. Shogo keeps retrying automatically; once it's been ~30 minutes you can also click **Retry certificate** to nudge it along. No DNS changes are needed.

## Related

- [Sharing Projects](/features/sharing-projects)
