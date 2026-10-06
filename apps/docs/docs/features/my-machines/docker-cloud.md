---
title: Docker projects in Shogo Cloud
sidebar_position: 5
---

# Docker projects in Shogo Cloud

A project whose stack is `docker-compose` runs on a Docker-capable cloud
machine. That machine already has a Docker daemon. The agent runs
`docker compose` inside the project; Studio shows the app through a preview
URL. You do not install Docker yourself, and you do not pair a laptop.

A normal Shogo Cloud sandbox is a single process tree and has no Docker
daemon. Use this page when the project needs compose (a database, a cache,
an API, a frontend). Use [Docker on your own machine](./docker-projects) when
you want the agent to run on a computer you already have.

## What you get

- A machine large enough for a typical compose stack (4 CPUs).
- A Docker data disk, separate from the project files. Images and named
  volumes live on that disk. It stays with the machine. Moving the project
  to a different host starts Docker storage over.
- One public preview URL per HTTP port you choose to publish. Other ports
  stay reachable from the agent and from an authenticated tunnel, and are
  not on the public internet.

## Ports

The stack file lists the ports the project expects. Port **8000** is the
usual preview for a compose app: one origin for the page, the API, and
login cookies. You can add more.

A port becomes a public preview only when you turn that on in Studio, or
when the agent calls `expose_port` and you approve it. Adding a port does
not publish it. The public preview looks like:

```text
https://8000--<projectId>.preview.shogo.ai
```

Replace `8000` with the port. Bounds:

- Ports from 1024 through 65535.
- At most 8 ports on a project.
- These ports are reserved and cannot be added: 22, 8002, 8012, 8080, 9900.

Studio lists ports that are actually listening, so a blank preview usually
means the process inside the machine has not bound that port yet.

## What the agent knows

When the project has exposed ports, the agent is told which ones exist and
how the preview URL is formed. It can call `expose_port` to add a port the
stack file did not declare. Publishing that port to the preview still asks
you to approve it.

The docker-compose stack guide tells the agent that the daemon is already
running, that the preview is port 8000 unless you say otherwise, and that
the Docker data disk does not follow the project across hosts.

## Cookies, streaming, and hot reload

The preview proxy forwards the browser's `Cookie`, `Authorization`, and
`Origin` headers, and it returns `Set-Cookie` from the app. Login that
depends on a cookie works through the preview URL.

Response bodies are streamed, so server-sent events are not buffered until
the handler finishes. WebSocket upgrades on a published port are passed
through, which is what a Vite dev server uses for hot reload.

## Turning a project into a Docker project

Create the project, or change its stack, to `docker-compose`. Shogo refuses
that change while the Docker project class is turned off for the workspace,
and it refuses a machine size smaller than the class requires. Connecting a
GitHub repo still succeeds if the detected stack cannot be applied; the
stack is left as it was and the skip is logged.

Inference looks for `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`,
or `compose.yaml` before it guesses from `package.json`.
