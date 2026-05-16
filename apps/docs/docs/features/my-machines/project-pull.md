---
title: Cloning projects to a paired machine
sidebar_position: 3
---

# `shogo project pull` and auto-pull

When you pin a project to a paired machine (Studio → Channels → **Run on**, or
`client.machines.pinProject()` from the SDK), external traffic for that project
is relayed through that machine's outbound tunnel. But "relayed" only covers
the request itself — the agent on the machine still needs the project's
workspace files (skills, plans, `config.json`, `AGENTS.md`, custom code).

`shogo project pull` is the single command that clones a project's workspace
from Shogo Cloud onto your paired machine. The `shogo worker` does this
automatically on first request by default, but you can also run it manually
when you want a local copy ahead of time.

## TL;DR

```bash
# One-time setup
shogo login                              # pair this machine with cloud
shogo runtime install                    # download the agent-runtime

# Manual clone (creates ~/.shogo/projects/<projectId>/)
shogo project pull <projectId>

# Or rely on auto-pull — start the worker and the first inbound
# request triggers the clone.
shogo worker start
```

## How it works — two transports, one experience

Every Shogo project's workspace is **both** a git repo on the cloud side
(`workspaces/<id>/.git`) AND a set of object-store files behind the Files API.
The worker picks the right transport depending on what's available and what
you're doing:

| Operation | Transport | Why |
|---|---|---|
| Auto-pull (first inbound request) | **git smart-HTTP** (default) | Pack-based delta sync; full checkpoint history reachable locally |
| `shogo project pull/push --watch` | Files API (presigned URLs) | Per-file granularity, `--include` filters, `.shogo/` SQLite |
| `agent-runtime` writes during a session | **git commit + push** (worker mode) | Cloud's post-receive hook materializes one `ProjectCheckpoint` per push |
| `.shogo/` SQLite state | Files API (always) | gitignored; needs byte-for-byte file copy |

### git mode (default when `git` is on PATH)

The worker shells out to local `git` against the cloud's smart-HTTP backend:

```
GET  /api/projects/:id/git/info/refs?service=git-upload-pack
POST /api/projects/:id/git/git-upload-pack   ← clone / fetch
POST /api/projects/:id/git/git-receive-pack  ← push
```

The bearer token rides in `-c http.extraHeader=Authorization: Bearer …` so
your API key never appears in `git remote -v` or `ps`. After each successful
push, the cloud's post-receive hook reads the new HEAD and writes a
`ProjectCheckpoint` row — so the desktop UI's checkpoint timeline reflects
what the agent did on the worker, with no extra round trips.

```mermaid
flowchart LR
  subgraph cloud [Shogo Cloud]
    GitBackend["git http-backend\nbehind /api/projects/:id/git/*"]
    Repo[("workspaces/<id>/.git")]
    FilesAPI[/Files API\n/workspace/manifest\n/files/* presign/]
    GitBackend --- Repo
    GitBackend -.post-receive hook.-> Checkpoints[("ProjectCheckpoint rows")]
  end
  subgraph worker [Paired machine]
    Manager["shogo worker"]
    Runtime["agent-runtime"]
    Watcher["watcher\n(commit + push mode)"]
    LocalRepo[("~/.shogo/projects/<id>/.git")]
    Manager --> Runtime
    Manager --> Watcher
    Watcher --> LocalRepo
  end
  Manager -- "git clone --depth=1" --> GitBackend
  Manager -- ".shogo/* SQLite bytes" --> FilesAPI
  Watcher -- "git push origin HEAD" --> GitBackend
```

### Files-only mode

When `git` isn't on PATH, or you pass `--no-git` to `shogo worker start`, the
worker walks the project's manifest via the Files API:

```
GET    /api/projects/:id/workspace/manifest      ← list every file in the project
POST   /api/projects/:id/s3/presign              ← batch read URLs
```

then downloads each file in parallel. No AWS credentials are exchanged with
your machine — the cloud mints short-lived presigned URLs per request, and
they're scoped to your workspace.

Manual `shogo project pull/push` always uses this path so `--include`
patterns and `--watch` debounced uploads work the same way regardless of
whether you have git installed.

## Manual pull / push

### Pull

```bash
shogo project pull <projectId>
shogo project pull <projectId> --into ./myproj      # custom destination
shogo project pull <projectId> --include "src/**,*.md"   # filter
shogo project pull <projectId> --watch              # pull + live bidirectional sync
```

`--watch` keeps a Node `fs.watch` running over the destination directory and
pushes any local edits back to cloud via `PUT /api/projects/:id/files/...`
(debounced 1.5s). Use this when you want to edit files locally with your
editor of choice and have those changes show up in Studio.

The pull is atomic: files land in `<dest>.shogo-pull-tmp/` first and rename
over the target on success, so a Ctrl-C mid-pull never leaves a half-populated
workspace.

### Push

```bash
shogo project push <projectId>
shogo project push <projectId> --from ./myproj
shogo project push <projectId> --delete-remote   # mirror local deletions (DESTRUCTIVE)
```

`shogo project push` uploads everything under the source directory back to
cloud. By default it only adds/updates files; `--delete-remote` makes it a
strict mirror — any file present in cloud but absent locally is deleted.

## Auto-pull (default for `cli_worker` instances)

`shogo worker start` enables auto-pull by default. When a tunneled request for
project `<id>` arrives:

1. If `~/.shogo/projects/<id>/` is empty, the worker tries `git clone
   --depth=1` against the smart-HTTP backend. If git isn't installed (or you
   passed `--no-git`), it falls back to the Files API and runs
   `CloudFileTransport.downloadAll()` instead.
2. **After a successful git clone**, the worker makes one more pass via the
   Files API to download `.shogo/*` (SQLite state, gitignored). This is the
   "full sync" path — your agent sees a coherent DB even though the rest of
   the workspace came in over the git wire.
3. It starts a {@link CloudSyncWatcher} on that directory so writes made by
   the local `agent-runtime` sync back to cloud automatically:
   - **In git mode** the watcher batches edits and `git add -A && git commit
     && git push`es the result. Each push records a `ProjectCheckpoint` row
     via the cloud's post-receive hook.
   - **In files mode** the watcher PUTs individual files to the Files API.
   - Either way, `.shogo/` SQLite writes always go through the Files API
     because they're gitignored.
4. It then spawns the `agent-runtime` with `PROJECT_DIR=<that dir>` and
   `SHOGO_CLOUD_SYNC=1`. The latter tells the runtime to skip its own
   built-in S3Sync **and** its own checkpoint insertion — the worker (and
   the cloud's post-receive hook) own sync now.

If the cloud is unreachable when the request arrives, auto-pull fails
**softly**: the runtime still starts with an empty workspace and falls back to
template defaults. The next request retries the pull.

### Disabling auto-pull or git

For users who manage their workspaces externally, pass `--no-auto-pull`:

```bash
shogo worker start --no-auto-pull --worker-dir /path/to/my/repo
```

To force the Files API path even when `git` is available (e.g. your VPS
firewall blocks outbound HTTPS to git pack-RPC endpoints, or you don't want
the worker shelling out to git), use `--no-git`:

```bash
shogo worker start --no-git
```

The worker will still route tunneled traffic — it just won't try to clone via
git.

### Rolling back to an earlier checkpoint

When the worker is in git mode, every commit pushed (including auto-checkpoints
made by the agent-runtime during a chat turn) is reachable as a regular git
SHA on the worker. `shogo project checkout` wraps the git ceremony:

```bash
shogo project checkout <projectId>                  # fast-forward to remote HEAD
shogo project checkout <projectId> --at abc1234     # check out a specific SHA
shogo project checkout <projectId> --at "before refactor"   # resolve checkpoint by name
shogo project checkout <projectId> --unshallow      # convert shallow clone to full
```

`--at` resolves against `GET /api/projects/:id/checkpoints` — the same list
the desktop checkpoint panel uses. See
[Checkpoints on the VPS](./checkpoints-on-the-vps.md) for examples.

### Changing the projects directory

```bash
shogo worker start --projects-dir /mnt/big-disk/shogo
# or persist it:
shogo config set projectsDir /mnt/big-disk/shogo
```

## SDK equivalent

`client.projects.pull/push` does the same thing programmatically. Useful when
you're scripting CI or building a custom dashboard:

```ts
import { createClient } from '@shogo-ai/sdk'

const shogo = createClient({
  apiUrl: 'https://api.shogo.ai',
  shogoApiKey: process.env.SHOGO_API_KEY,
})

await shogo.projects.pull('proj_abc123', {
  into: './staging-snapshot',
  include: ['src/**', 'AGENTS.md', 'config.json'],
  onProgress: ({ kind, path, index, total }) => {
    console.log(`[${kind}] ${index + 1}/${total} ${path}`)
  },
})

// edit some files locally...

await shogo.projects.push('proj_abc123', {
  from: './staging-snapshot',
  deleteRemote: false,
})
```

The SDK accepts an injected `fetch` and `fs` adapter so you can pull inside an
edge function, a browser sandbox, or a unit test.

## Troubleshooting

**"No API key configured"** — the CLI couldn't find a `shogo_sk_*` key. Run
`shogo login` again or set `SHOGO_API_KEY=...` in your shell.

**"manifest_failed: HTTP 403"** — the API key doesn't have access to that
project. Check it's the right workspace key and the project hasn't been moved.

**"Pull aborted with N errors"** — at least one file failed to download. The
staging directory at `<dest>.shogo-pull-tmp/` is left intact so you can
inspect; once you've fixed the underlying issue, just rerun `shogo project
pull`.

**Auto-pull never fires** — confirm `shogo worker status` shows the worker is
running, and that the project is pinned to this machine in Studio. The pull
only triggers on the first **tunneled** request; chat requests that go to a
cloud pod won't kick it off.

## Sensitive files

The cloud Files API refuses to expose paths matching `.env*`, `*.pem`,
`*.key`, `id_rsa*`, or `credentials*`. They're stripped from the manifest and
`DELETE` is forbidden. Keep secrets in environment variables on each machine,
not in the project workspace.
