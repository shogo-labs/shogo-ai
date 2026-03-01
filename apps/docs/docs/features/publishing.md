---
sidebar_position: 8
title: Publishing Your App
slug: /features/publishing
---

# Publishing Your App

Publishing turns your Shogo project into a live web app that anyone can visit. With one click, your app goes from a preview in the editor to a real URL on the internet.

## How publishing works

When you publish:

1. Shogo **builds** your app into a production-ready version.
2. Your app is **deployed** to Shogo's hosting infrastructure.
3. A **database** is automatically set up for your published app (PostgreSQL).
4. Your app is available at a live **URL** like `yourapp.shogo.one`.

The entire process takes just a few moments.

## Publishing your app

1. Click the **Publish** button in the top-right corner of the project editor.
2. **Choose a subdomain** — This is your app's URL. For example, if you enter `my-crm`, your app will be at `my-crm.shogo.one`.
3. **Set access** — Choose who can visit your app (see [Access Control](./access-control)).
4. Click **Publish**.

When the deployment is complete, you'll see your live URL. Click it to visit your app!

:::tip Choose a good subdomain
Pick something short, memorable, and related to your app's purpose. Subdomains can contain letters, numbers, and hyphens.
:::

## Updating your published app

After publishing, you can keep making changes to your app through chat. These changes are only visible in the editor preview until you publish again.

To push updates live:

1. Click the **Publish** button.
2. Click **Update**.

Your live app will be updated with all changes made since the last publish.

:::info
Publishing creates a snapshot. Changes you make after publishing are not live until you publish again.
:::

## Unpublishing

If you want to take your app offline:

1. Go to **Project Settings**.
2. Find the **Unpublish** option.
3. Click **Unpublish**.

Your app will no longer be accessible at its URL. Your project, code, and data are preserved — only the public URL is removed. You can republish at any time.

## What gets published

When you publish, the full app is deployed:

- All pages and navigation
- All features and functionality
- The database (automatically provisioned)
- Authentication (if your app has user login)

## Database in published apps

Your published app gets its own PostgreSQL database. This means:

- **Data persists** — Information entered by users of your live app is saved
- **Automatic setup** — You don't need to configure anything
- **Separate from development** — The published app's database is independent from your project editor
- **Preserved on unpublish** — If you unpublish and later republish, your data is still there

## FAQ

**How long does publishing take?**
Usually a few moments. The exact time depends on the size and complexity of your app.

**Can I use a custom domain?**
Custom domain support is on the roadmap. Currently, all published apps are available at `yoursubdomain.shogo.one`.

**Is there a limit to how many apps I can publish?**
You can publish as many apps as you have projects. There's no additional cost for publishing.

**Can I see how many people visit my app?**
Analytics features are available in the project settings.

**What happens if my app has an error after publishing?**
Go back to the editor, fix the issue through chat, test in the preview, and then update the published version.

**Can I publish multiple versions?**
Each publish replaces the previous version. The latest publish is always what's live.
