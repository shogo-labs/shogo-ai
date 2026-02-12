---
sidebar_position: 9
title: Access Control
slug: /features/access-control
---

# Access Control

When you publish an app, you can control who can visit it. This is separate from [project sharing](./sharing-projects), which controls who can edit the project.

## Access levels

When publishing, you can choose from three access levels:

### Anyone

Your app is publicly accessible. Anyone with the URL can visit and use it.

**Best for:**
- Public websites and landing pages
- Apps you want to share broadly
- Portfolio projects and demos

### Authenticated

Only users who have a Shogo account and are logged in can access your app.

**Best for:**
- Apps for a known user base
- Tools where you want to track who's using them
- Apps that require user accounts

### Private

Only members of your workspace can access the app.

**Best for:**
- Internal tools for your team
- Apps in development that aren't ready for the public
- Sensitive business applications

## Setting access when publishing

1. Click the **Publish** button.
2. In the publish dialog, find the **Access** setting.
3. Choose **Anyone**, **Authenticated**, or **Private**.
4. Click **Publish** (or **Update** if already published).

You can change the access level at any time by publishing again with a different setting.

## Understanding the difference: Project visibility vs. app access

Shogo has two independent visibility controls:

| Setting | What it controls | Where to set it |
|---------|-----------------|-----------------|
| **Project visibility** | Who can open the project editor and see the source code | Project Settings |
| **App access** | Who can visit the published app at its live URL | Publish dialog |

These are completely independent:

- A project can be private (only you edit it) but the published app can be public (anyone can visit)
- A project can be shared with your team but the published app can be restricted to workspace members only

## FAQ

**Can I password-protect my app?**
The **Private** access level restricts access to workspace members only. For additional protection, you can ask the AI to add login/authentication features to your app.

**Can I change access after publishing?**
Yes. Click **Publish** again and change the access setting before clicking **Update**.

**What do visitors see if they don't have access?**
They'll see a message indicating they don't have permission to view the app.

**Does access control cost extra?**
No. Access control is available on all plans at no extra cost.
