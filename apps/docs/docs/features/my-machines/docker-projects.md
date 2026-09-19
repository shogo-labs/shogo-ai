---
title: Running Docker-based projects on your own machine
sidebar_position: 4
---

# Running Docker-based projects on your own machine

Shogo Cloud sandboxes run a single Node/Bun/Python process tree. They do
**not** ship a Docker daemon, so a project that needs `docker compose up`
(Postgres, Redis, MinIO, a Python API, background workers, ...) cannot run in
the hosted sandbox today.

The supported way to work on that kind of project with Shogo is **bring your
own compute**: pair a machine that already has Docker with Shogo, and let the
agent run there. The agent's shell, file edits and MCP calls execute on your
machine; the model, chat history and Studio UI stay in the cloud.

There are two ways to do it. Pick the one that matches where Docker lives.

| You want to... | Use | Studio runs in |
|---|---|---|
| Work on a repo that is already on your laptop, see the app in a preview tab | **Route A: Shogo Desktop** | The Desktop app on the same machine |
| Drive a devbox / VPS / spare Linux box from any browser | **Route B: `shogo worker`** | studio.shogo.ai in your browser |

Both routes work with the same repo. Route A is the shortest path for a
developer at their own machine; Route B is for shared or always-on machines.

## Before you start (both routes)

- **Docker is installed and running** on the machine: Docker Desktop
  (macOS/Windows) or Docker Engine + the Compose v2 plugin (Linux). `docker
  compose version` should print a version.
- **The user that runs Shogo can talk to the daemon** without `sudo`. On Linux,
  add yourself to the `docker` group and log in again. The agent is never
  allowed to run `sudo`, so a daemon that needs root will not work.
- **Enough headroom.** A typical multi-service compose stack (database, cache,
  object store, auth, API) wants 8 GB of free RAM and 20 GB of free disk for
  images and volumes. The machine must stay awake while the agent works.
- **Do not set `SANDBOX_EXEC_ENABLED`** in the worker's environment. That flag
  wraps every agent command in `docker run --network none`, which breaks
  nested `docker compose` and removes network access. It is off by default on
  paired machines; leave it that way.
- **Secrets stay on the machine.** Shogo's file sync deliberately refuses to
  transfer `.env*`, `*.pem`, `*.key` and `credentials*`. Create your `.env`
  locally the same way you would without Shogo.

## Route A: Shogo Desktop on the machine that has Docker

Best when the repo is already on your laptop and you want the preview, IDE and
terminal in one window.

1. Install and sign in to **Shogo Desktop**.
2. On the home screen open the **Source** chip next to the composer and choose
   **Open folder...**. Pick the repo root (for example
   `~/git/my-compose-project`). If you pick a subfolder inside a git repo,
   Shogo offers to use the repo root instead. This creates an *external*
   project that points at your folder; nothing is copied.
3. In the project's **Folders** panel set the **External preview URL** to the
   port your app serves on, for example `http://localhost:8000`. Only
   `localhost`/`127.0.0.1` URLs are accepted. The preview tab now shows your
   app once the stack is up.
4. Let the agent use Docker. Go to **Settings > Security** and either pick
   **Full Autonomy**, or stay in **Balanced** and click **Always Allow** the
   first time the agent asks to run `docker` / `docker compose`. In Balanced
   mode `docker` is not on the default allowlist, so without this the agent
   will pause and ask on every compose command.
5. Tell the agent how the project runs. Add (or extend) an `AGENTS.md` at the
   repo root, for example:

   ```markdown
   ## Running locally
   - Start everything: `docker compose -f docker-compose.generic.yml up -d --build`
   - Logs: `docker compose logs -f api`
   - Tests run inside the api container: `docker compose exec api pytest`
   - The API is on http://localhost:8000; Postgres on localhost:5432.
   ```

6. Ask for something. A good first prompt:

   > Bring the compose stack up, wait until the API health check passes, then
   > show me the logs for the api service.

   Long-running commands such as `docker compose up` are moved to the
   background automatically; the agent polls them instead of blocking.

Everything the agent does is visible in the Desktop terminal and the IDE's
source-control view, and you can run `docker` yourself in the same terminal.

## Route B: headless `shogo worker` on a devbox or VPS

Best for a machine you reach over SSH and want to drive from a browser (or from
your phone).

### 1. Install Docker on the box

Follow Docker's instructions for the distro, then confirm from the account
that will run the worker:

```bash
docker compose version
docker run --rm hello-world
```

### 2. Install and pair the Shogo CLI

```bash
curl -fsSL https://install.shogo.ai | bash     # single binary in ~/.shogo/bin
shogo login                                    # browser device flow; or --api-key shogo_sk_...
shogo runtime install                          # downloads the agent-runtime
```

The machine needs **outbound HTTPS only** (`api.shogo.ai`, `api-direct.shogo.ai`,
`artifacts.shogo.ai`, plus GitHub for the runtime download). No inbound ports
are opened. See [Networking & allowlist](./networking) for the full list.

### 3. Create the project in Studio and pin it to the machine

1. In [studio.shogo.ai](https://studio.shogo.ai) create a new project. Use the
   **None** tech stack: you are bringing your own repo, not a Shogo template.
2. Copy the project id from the URL (`/projects/<projectId>`).
3. Pin the project to this machine so every turn runs there:
   **project > Channels > Run on** and pick the machine. (You can instead pick
   the machine per session from the **Environment** switcher next to the chat
   input, but pinning is what you want for a Docker project.)

### 4. Put the repo where the worker expects it

The worker runs each project from `~/.shogo/projects/<projectId>/`. By default
it clones the *Shogo Cloud* copy of the workspace into that folder on the
first request, which for a brand-new project is empty. For an existing repo
you have two options:

**Option 1: keep Shogo's sync (recommended for most people).** Clone your
repo into the canonical path *before* the first request:

```bash
mkdir -p ~/.shogo/projects
git clone git@github.com:your-org/your-compose-project.git ~/.shogo/projects/<projectId>
shogo worker start --name devbox
```

Because the folder already contains a `.git/`, the worker trusts it and skips
the cloud clone. It then watches the folder and, after each agent edit, runs
`git add -A && git commit && git push` **to the project's Shogo Cloud
repository** (not to your `origin`). Every push becomes a checkpoint in
Studio, so you get the checkpoint timeline and file browser in the browser.
Your GitHub remote is untouched; push there yourself when you are ready.

**Option 2: no sync, plain checkout.** If you do not want auto-commits at all
(for example the repo has a strict PR workflow or is very large):

```bash
git clone git@github.com:your-org/your-compose-project.git ~/.shogo/projects/<projectId>
shogo worker start --name devbox --no-auto-pull
```

With `--no-auto-pull` the worker uses the pre-existing folder as-is and starts
no watcher. Studio's file browser and checkpoints will not reflect the
machine's files; the agent still works normally and you manage git yourself.

:::tip
`--worker-dir` is **not** the project workspace; it is only the working
directory of the `shogo worker` process. Projects always resolve to
`<projectsDir>/<projectId>/`. Change the root with `--projects-dir` or
`shogo config set projectsDir /mnt/big-disk/shogo` if the default disk is small.
:::

### 5. Grant Docker permissions and describe the stack

- Add an `AGENTS.md` to the repo as shown in Route A so the agent knows the
  compose file, ports and test commands.
- Permissions: the first time the agent asks to run `docker compose ...`,
  choose **Always Allow** in the approval dialog. Alternatively set the project
  to **Full Autonomy** when you create it. The rule is stored in the
  workspace's `.shogo/permissions.json` on the machine.

### 6. Reach the running app

The worker tunnel carries **agent traffic only**. Ports your containers open
(8000, 5432, 9000, ...) are not forwarded to the browser and will not appear in
the Studio preview iframe. To look at the app yourself:

```bash
# from your laptop
ssh -L 8000:localhost:8000 -L 5432:localhost:5432 user@devbox
# then open http://localhost:8000
```

or bind the service to the box's LAN/VPN address in your compose file. The
agent itself does not need any of this: it can `curl http://localhost:8000`,
run tests inside the containers and read logs directly on the machine.

### 7. Keep the worker running

`shogo worker start` detaches by default and survives your SSH session ending.
For a box that reboots, run it as a user service with `--foreground`:

```ini
# ~/.config/systemd/user/shogo-worker.service
[Unit]
Description=Shogo worker
After=network-online.target docker.service

[Service]
ExecStart=%h/.shogo/bin/shogo worker start --foreground --name devbox
Restart=always

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now shogo-worker
loginctl enable-linger $USER      # keep user services alive after logout
```

Useful commands: `shogo worker status`, `shogo worker logs`, `shogo doctor`,
`shogo worker stop`.

## How it behaves

- **Idle runtimes.** The per-project agent process on the machine is stopped
  after 15 minutes of inactivity and restarted on the next message. Your
  containers are *not* stopped; they keep running under Docker.
- **Sleep and offline.** If the machine sleeps or loses network, the instance
  shows offline in **Settings > Remote Control** and pinned turns fail with
  `instance_offline` until it reconnects. Turn off sleep on a laptop you use
  as a worker.
- **Multiple projects** can be pinned to one machine; the worker spawns one
  agent process per project (up to 10, least-recently-used evicted).
- **Security.** The agent runs as your OS user with your shell, files, Docker
  socket and any credentials on that machine. Balanced mode asks before
  destructive commands; Full Autonomy does not. Use a dedicated user or a
  dedicated box for anything you would not run on your own laptop.

## What is not supported today

- A hosted (Shogo Cloud) sandbox with Docker inside it. This is on the roadmap
  as a separate, larger project class; until then use one of the routes above.
- Forwarding container ports through the worker tunnel to the browser Studio
  preview. Use Route A's External preview URL, or an SSH tunnel with Route B.
- `sudo`. It is blocked in every permission mode. Anything that needs root
  (installing Docker, adding users to the `docker` group) is a one-time setup
  step you do yourself.
- Windows hosts are less tested for Docker workloads. Prefer Docker Desktop
  with the WSL 2 backend and run the worker inside WSL so `docker` is on the
  agent's `PATH`.

## Troubleshooting

**`docker: command not found` in agent output** — the worker inherited a
`PATH` without Docker. Start the worker from a login shell where `docker`
resolves, or restart it after installing Docker Desktop.

**`permission denied while trying to connect to the Docker daemon socket`** —
the worker's user is not in the `docker` group, or Docker Desktop is not
running. Fix that on the machine; the agent cannot `sudo`.

**The agent keeps asking to run `docker compose`** — you are in Balanced mode
and have not clicked **Always Allow**, or the allow rule was saved for a
different command shape. Approve once with Always Allow, or switch the project
to Full Autonomy.

**`docker compose up` "hangs"** — it does not; the command was backgrounded
after the exec soft-timeout and the agent should follow up with the run id. If
it forgot, ask it to check `docker compose ps`.

**Auto-pull overwrote / did not see my checkout** — make sure the clone landed
at exactly `~/.shogo/projects/<projectId>/` (with a `.git/` inside) before the
first tunneled request, or start with `--no-auto-pull`.

**The Studio preview is blank** — expected on Route B; the tunnel does not
carry container ports. On Route A, check the External preview URL matches the
port your compose file publishes.

## See also

- [My Machines quickstart](./quickstart)
- [Cloning projects to a paired machine](./project-pull) — details on auto-pull, git vs. file sync, `--no-git`
- [Networking & allowlist](./networking)
- [Troubleshooting](./troubleshooting)
