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
- A **subdomain** to point at your app, such as `app.acme.com` or `www.acme.com`. See [Apex vs. subdomains](#apex-vs-subdomains) below.

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

1. Type the domain you want to use, e.g. `app.acme.com`.
2. Click **Add**.

Shogo registers the domain and shows you the exact **DNS records** to create.

## Step 3 — Create the DNS records

Shogo shows one or more records to add at your DNS provider. Each record has a **Name** and a **Value** with a copy button. You'll usually see:

- A **CNAME** record — routes your domain's traffic to Shogo.
- A **TXT** record — confirms you own the domain and validates your SSL certificate.

Copy each value exactly and add it at your DNS provider. Where you do this varies by provider — look for a section called **DNS**, **Records**, or **Advanced DNS**.

:::tip
Copy the values straight from Shogo instead of typing them. A single wrong character will stop verification.
:::

## Step 4 — Check status

Back in Shogo, click **Check status**. Shogo re-checks your DNS records and SSL certificate, and the status updates as it goes:

| Status | What it means |
| --- | --- |
| **Awaiting DNS** | The records haven't been detected yet. Add them and check again. |
| **Verifying** | Records were found; your SSL certificate is being issued. |
| **Live** | Your domain is active and serving your app over HTTPS. |
| **Failed** | Something needs attention — read the message shown, fix it, and check again. |

Once the status is **Live**, open `https://app.acme.com` and your app will load on your own domain.

DNS changes can take anywhere from a few minutes to a few hours to take effect, so it's normal to check back a little later. You don't have to manage SSL yourself — certificates are issued and renewed automatically.

## Apex vs. subdomains

We recommend using a **subdomain** such as `app.acme.com` or `www.acme.com`.

A root/apex domain (`acme.com` with nothing in front) can't always use the required CNAME record. It only works if your DNS provider supports **CNAME flattening** or **ALIAS** records — Cloudflare, for example, does. If yours doesn't, use a subdomain instead.

## Remove a domain

To stop serving your app from a custom domain, open the **Custom domain** section and click the trash icon next to it. You can add it back later if you change your mind.

## Troubleshooting

**Status stuck on "Awaiting DNS."** The records aren't visible to Shogo yet. Double-check that the Name and Value match exactly, confirm they're saved at your provider, and give DNS time to propagate before checking again.

**Status shows "Failed."** Read the message next to the domain. The most common causes are a typo in a record or a conflicting record already on the same name (such as an old A or CNAME record). Fix it, then click **Check status**.

**The page loads but shows a security warning.** Your SSL certificate is still being issued. Wait a few minutes after the records verify, then reload.

## Related

- [Sharing Projects](/features/sharing-projects)
