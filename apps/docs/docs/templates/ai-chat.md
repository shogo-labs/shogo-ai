---
sidebar_position: 10
title: AI Chat
slug: /templates/ai-chat
---

# AI Chat Template

A conversational AI interface for building chatbot-style applications. Create apps where users can interact through a chat-like experience.

## What's included

- **Chat interface** — A clean, modern chat UI with message bubbles
- **Message history** — Conversation is preserved and scrollable
- **Input area** — Text input with send button
- **Message types** — Support for user messages and AI/system responses
- **Responsive design** — Works on desktop and mobile

## Data model

**Message**
| Field | Type | Description |
|-------|------|-------------|
| Content | Text | The message text |
| Role | Selection | User, Assistant, System |
| Timestamp | Date | When the message was sent |
| Session | Reference | Which conversation it belongs to |

**Session**
| Field | Type | Description |
|-------|------|-------------|
| Title | Text | Conversation title |
| Created at | Date | When the conversation started |
| Status | Selection | Active, Archived |

## Getting started

1. Go to **Templates** and select **AI Chat**.
2. Click **Use Template** to create your project.
3. Try the chat interface and see how messages are displayed.
4. Customize the chat experience for your use case.

## Customization ideas

> "Add a sidebar with conversation history so users can switch between chat sessions."

> "Add the ability to choose different 'personas' or topics for the chat."

> "Add rich message types — images, links, and formatted text in responses."

> "Add a typing indicator when the AI is 'thinking'."

> "Add a welcome message that explains what the chatbot can help with."

## Who this is for

- Businesses building customer support chatbots
- Developers creating AI-powered assistants
- Educators building interactive learning tools
- Anyone who wants a conversational interface in their app
