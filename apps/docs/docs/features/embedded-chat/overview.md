---
title: Embedded Agent Chat
sidebar_position: 1
---

# Embedded Agent Chat

Add the same Shogo chat experience to a customer website as either an
Intercom-style launcher or a full-page chat route.

The chat SDK supports two transports:

- **Persona** — stateless streaming chat backed by the project's cloud
  `ProjectAgent`.
- **Runtime** — the live agent runtime with tools, memory, typing events, and
  durable WebChat sessions.

Both transports use the same UI message stream and can render the shared Shogo
chat UI.

## Choose a delivery method

Use the [React quickstart](./quickstart-react) when you control the site's
build. Use the [script-tag quickstart](./quickstart-script-tag) for a site
builder or a page where adding a package isn't practical. Both surfaces
support launcher and full-page modes.
