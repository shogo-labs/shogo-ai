---
sidebar_position: 4
title: FAQ
slug: /getting-started/faq
---

# Frequently Asked Questions

## General

### What is Shogo?

Shogo is an AI-powered platform for building web applications. You describe what you want in plain language, and the AI builds it for you. You can preview changes in real time, iterate through conversation, and publish your app to a live URL with one click.

### Do I need to know how to code?

No. Shogo is designed for non-technical users. You build your app entirely through chat. If you are technical, you can optionally use the built-in code editor and terminal for more control.

### What kind of apps can I build?

You can build a wide range of web applications: task managers, CRMs, booking systems, dashboards, inventory trackers, landing pages, forms, and more. See [What can you build?](./welcome#what-can-you-build) for examples.

### Is Shogo free?

Yes, there is a free plan that gives you 5 credits per day (up to 150/month). Paid plans are available for users who need more credits. See [Plans and Credits](./plans-and-credits) for details.

## Building apps

### How do I start a new project?

From your dashboard, click **New Project** to start from scratch, or go to **Templates** to start from a pre-built template. See the [Quick Start guide](./quick-start) for a full walkthrough.

### How does the AI chat work?

The chat panel is on the left side of the project editor. Type a message describing what you want (e.g., "Add a contact form with name, email, and message fields"), and the AI will make the changes to your app. You'll see the results in the live preview instantly.

### Can I undo changes?

Yes. Shogo keeps a history of all changes. You can revert to any previous version from the History panel. See [History and Checkpoints](../features/history-and-checkpoints) for details.

### What are templates?

Templates are pre-built starter apps that give you a head start. Instead of starting from a blank project, you can choose a template (like a Todo App, CRM, or Kanban Board) and customize it through chat. See [Templates](../templates/) for the full list.

### Can I attach images to my messages?

Yes, you can attach screenshots or design mockups to your chat messages to help the AI understand what you want.

## Publishing and sharing

### How do I publish my app?

Click the **Publish** button in the top-right corner of the project editor. Choose a subdomain, set access permissions, and click **Publish**. Your app will be live at `yoursubdomain.shogo.one`. See [Publishing](../features/publishing) for details.

### Can I use my own domain?

Custom domain support is on the roadmap. Currently, all published apps are available at `yoursubdomain.shogo.one`.

### Who can see my published app?

You control this. When publishing, you can choose:
- **Anyone** — The app is publicly accessible
- **Authenticated** — Only logged-in users can access it
- **Private** — Only you and your workspace members can access it

### How do I update my published app?

After making changes through chat, click **Publish** again and select **Update**. Your live app will be updated with the latest changes.

### Can I unpublish my app?

Yes. Go to your project settings and click **Unpublish**. The app will no longer be accessible at its URL.

## Workspaces and collaboration

### What is a workspace?

A workspace is a shared space where you and your team can organize projects. Each workspace has its own billing, members, and project list. You can be a member of multiple workspaces.

### Can I invite team members?

Yes. Go to **Members** in your workspace settings and send invitations by email. Members can be assigned the role of **Owner** or **Member**.

### Can I share a project with someone?

Yes. You can share projects within your workspace. Use the sharing settings in your project to control who can view and edit.

## Account and billing

### How do credits work?

Each message you send to the AI costs one credit. Your plan determines how many credits you get each month. See [Plans and Credits](./plans-and-credits) for details.

### What happens when I run out of credits?

You won't be able to send messages to the AI until your credits reset or you upgrade your plan. Your existing projects and published apps are not affected.

### How do I change my plan?

Go to **Settings > Billing** to view your current plan and upgrade or downgrade. Changes take effect immediately for upgrades, and at the next billing period for downgrades.

### How do I cancel my subscription?

Go to **Settings > Billing** and click on your subscription management link. You can cancel at any time, and you'll retain access until the end of your current billing period.

## Technical

### What technologies does Shogo use?

Shogo-built apps use modern web technologies including React, TypeScript, and PostgreSQL. However, you don't need to know any of these — the AI handles the technical implementation.

### Is there an SDK for developers?

Yes. The Shogo SDK (`@shogo-ai/sdk`) lets developers integrate Shogo-powered features (authentication, database, email) into their own projects. See the [SDK documentation](../sdk/introduction) for details.

### Is my code exportable?

Your project code is accessible through the built-in code editor. You can view and copy any file in your project.

### Where is my data stored?

Your app data is stored in a PostgreSQL database that is automatically provisioned when you publish. Data is hosted securely on our infrastructure.
