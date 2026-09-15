---
title: Script-tag quickstart
sidebar_position: 3
---

# Script-tag quickstart

The script embed works on plain HTML, Webflow, WordPress, and other sites
where installing a package is not practical:

```html
<script
  src="https://api.shogo.ai/embed/v1/chat.js"
  data-project-id="proj_123"
  data-publishable-key="shogo_pk_..."
  data-transport="persona"
></script>
```

Set `data-transport="runtime"` after connecting a WebChat channel to use the
live runtime. The loader creates an isolated iframe, so its styles do not
leak into the host page.

Use `data-mode="page"` and `data-target="#support-chat"` to mount the full
page experience into an existing element.
