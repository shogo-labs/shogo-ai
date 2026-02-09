---
sidebar_position: 2
title: Project Editor
slug: /features/project-editor
---

# Project Editor

The project editor is where you build your app. It combines a chat panel, live preview, code editor, terminal, database view, and more — all in one interface.

:::tip For non-technical users
You can build your entire app using just the **Chat** and **Preview** panels. The code editor and terminal are optional power tools for users who want more control.
:::

## Editor layout

When you open a project, you'll see:

- **Chat panel** (left side) — Where you send messages to the AI to build and modify your app.
- **Preview panel** (right side) — A live view of your running app.
- **View tabs** (top of right panel) — Switch between Preview, Code, Terminal, Database, Tests, and History.

## Views

### Preview

The default view. Shows your running app exactly as users will see it. You can:

- Switch between **Desktop**, **Tablet**, and **Mobile** viewport sizes
- Navigate between pages using the URL bar
- Refresh the preview manually

See [Live Preview](./live-preview) for more details.

### Code

A full code editor (powered by Monaco — the same editor used in VS Code) with:

- **File tree** — Browse all files in your project on the left
- **Editor** — View and edit any file
- **Syntax highlighting** — For TypeScript, JavaScript, CSS, HTML, JSON, and more

This is entirely optional. The AI manages your code when you use the chat, but you can view or hand-edit files here if you want.

### Terminal

An integrated terminal for running commands. This is useful for developers who want to:

- Install packages
- Run scripts
- Debug issues
- View logs

:::note
The terminal is a developer tool. Non-technical users don't need to use it — the AI handles everything through chat.
:::

### Database

View your app's data in a table format. When your app stores data (like tasks, contacts, or products), you can browse it here. See [Database](./database) for more details.

### Tests

View and run tests for your app. The AI can generate tests when asked, and you can see results in this panel.

### History

Browse your conversation history, view previous chat sessions, and manage checkpoints. See [History and Checkpoints](./history-and-checkpoints) for details.

## Project settings

Click the **Settings** icon in the project editor to access:

- **Project name** — Rename your project
- **Publish settings** — Manage your published app URL and access control
- **Project visibility** — Control who can see your project
- **Danger zone** — Delete the project

## Navigation

Use the sidebar or the top bar to navigate:

- **Back to Dashboard** — Click the Shogo logo or use the back button
- **Command Palette** — Press `Cmd+K` (Mac) or `Ctrl+K` (Windows) to quickly search and navigate
- **Keyboard shortcuts** — See [Keyboard Shortcuts](../reference/keyboard-shortcuts)
