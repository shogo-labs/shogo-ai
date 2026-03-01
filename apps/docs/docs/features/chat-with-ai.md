---
sidebar_position: 1
title: Chat with AI
slug: /features/chat-with-ai
---

# Chat with AI

The chat panel is how you build with Shogo. It's on the left side of the project editor. Type what you want, and the AI agent creates, modifies, and improves your app in real time.

## How it works

1. **You type a message** describing what you want — a new page, a feature, a design change, or a bug fix.
2. **The AI agent processes your request** and makes the changes to your project files.
3. **The live preview updates** so you can see the result immediately.
4. **You iterate** — ask for adjustments, add more features, or move on to the next thing.

Each message costs **one credit**. See [Plans and Credits](../getting-started/plans-and-credits) for details.

## What the AI can do

The AI agent can handle a wide range of tasks:

- **Create pages** — "Add a Settings page with options for name, email, and password."
- **Add features** — "Add a search bar that filters the list of contacts by name."
- **Build forms** — "Create a contact form with name, email, phone, and a submit button."
- **Design and style** — "Change the color scheme to dark blue with white text."
- **Work with data** — "Add a list of products with name, price, and category fields."
- **Fix problems** — "The submit button doesn't work. Can you fix it?"
- **Add navigation** — "Add a sidebar with links to Dashboard, Projects, and Settings."
- **Create layouts** — "Make a two-column layout with a sidebar on the left and main content on the right."

## Tips for writing good messages

### Be specific

The more detail you provide, the better the result.

**Less effective:**
> "Add a table."

**More effective:**
> "Add a table showing all customers with columns for name, email, phone number, and signup date. Make it sortable by any column."

### One thing at a time

Break complex requests into smaller steps. This gives you more control and makes it easier to iterate.

**Instead of this:**
> "Build a complete user management system with login, registration, profile pages, admin panel, and password reset."

**Try this sequence:**
> 1. "Add a login page with email and password fields."
> 2. "Add a registration page with name, email, and password."
> 3. "Create a profile page that shows the logged-in user's information."
> 4. "Add an admin panel that lists all users."

### Describe what you see, not what to code

You don't need to use technical language. Describe the result you want as if you're explaining it to a designer.

> "I want a card for each product that shows the product image at the top, the name in bold below it, and the price in the bottom-right corner."

### Attach images for visual ideas

You can attach screenshots, mockups, or sketches to your messages. This is especially helpful for design-related requests.

- Paste a screenshot of a design you like
- Attach a sketch drawn on paper or in a tool
- Share a screenshot of a bug you're experiencing

## The chat interface

### Message history

Your entire conversation history is preserved for each project. You can scroll up to see previous messages and the changes the AI made.

### Session management

Each time you open a project, a new chat session begins. Previous sessions are saved and can be reviewed in the History panel.

### Streaming responses

When the AI is working, you'll see its response stream in real time. The preview updates as changes are applied.

## FAQ

**Is there a limit to message length?**
There's no strict limit, but shorter, focused messages tend to produce better results than very long ones.

**Can the AI remember context from earlier messages?**
Yes. The AI has context of your conversation within the current session. It understands what your app looks like and what changes have been made.

**What if the AI makes a mistake?**
You can ask it to undo or adjust. You can also revert to a previous version using [History and Checkpoints](./history-and-checkpoints).

**Does the AI work with templates?**
Yes. If you start from a template, the AI understands the existing app structure and can modify and extend it.
