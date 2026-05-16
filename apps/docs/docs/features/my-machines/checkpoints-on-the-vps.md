---
title: Checkpoints on the VPS
sidebar_position: 4
---

# Checkpoints on a paired machine

When the worker auto-pulls a project via git, the paired machine ends up with
a real git repo at `~/.shogo/projects/<projectId>/.git`. That means **every
checkpoint** Shogo has ever recorded for the project — auto-checkpoints from
agent chat turns, manual snapshots you took in Studio, even rollback points —
is a regular reachable git commit on your VPS.

This is the inverse of "Shogo manages git for you." The cloud still owns the
write path (the worker pushes commits up; the cloud's post-receive hook
materializes a `ProjectCheckpoint` row); but locally you have an ordinary git
repo you can `git log`, `git diff`, and `git checkout` like any other.

## See the timeline

```bash
cd ~/.shogo/projects/<projectId>
git log --oneline -20
```

You'll see entries like:

```
e3f8a01 auto: 2026-05-15T14:32:11.480Z
4b2c109 AI: edit_file (3 tool calls)
a0e774d Before pricing-page refactor          ← named checkpoint
…
```

The same SHAs are visible in Studio's checkpoint panel — that's the single
source of truth in `ProjectCheckpoint` Postgres rows, populated by the cloud
on every push.

## Roll the workspace back

`shogo project checkout` wraps `git fetch && git reset --hard` and resolves
named checkpoints against the cloud's `/checkpoints` listing:

```bash
# By full or short SHA
shogo project checkout <projectId> --at a0e774d

# By named checkpoint (case-insensitive substring match on name/message)
shogo project checkout <projectId> --at "before pricing-page refactor"

# Fast-forward to the latest commit in the cloud
shogo project checkout <projectId>

# Reach further back than the default --depth=1 clone
shogo project checkout <projectId> --at <old-sha> --unshallow
```

After a checkout the worker's `agent-runtime` (if running) will see the
restored files on its next chat turn. The watcher pauses its push during a
checkout to avoid race-pushing a "reverted" commit back up.

## What about the runtime's own writes?

When `SHOGO_CLOUD_SYNC=1` is set (which the worker does whenever auto-pull is
on), the `agent-runtime` skips its built-in S3 sync **and** its built-in
checkpoint inserts. The cloud's post-receive hook is the single writer of
`ProjectCheckpoint` rows in worker mode — so you can't end up with two rows
for the same SHA, and you can't push from the worker faster than the cloud
records it.

## Audit trail

Every push from the worker is authenticated with a `shogo_sk_*` key (yours,
not someone else's). The post-receive hook stamps each new `ProjectCheckpoint`
with that key's owner as `createdBy`, so you can grep the timeline for "who
made this commit" without trawling git's author fields.

## Caveats

- **One writer per project.** Shogo doesn't expect two workers (or a worker +
  the desktop) pushing into the same project's repo concurrently. If you set
  up two-machine redundancy, pin per-project to avoid push conflicts.
- **`receive.denyCurrentBranch=updateInstead`** is set on the cloud-side repo,
  so pushes that fast-forward and find a clean working tree will also update
  the checkout. If the cloud-side workspace has uncommitted changes (only
  possible if the project was ever served from the cloud directly), the push
  will be rejected and you'll see `error: cannot update the current branch in
  a non-bare repository`.
- **`.shogo/` is gitignored.** Your SQLite history and per-checkpoint DB
  snapshots travel through the Files API, not the git wire. `shogo project
  checkout` does NOT touch them — running it leaves the on-disk DB alone, and
  the next request fixes things up.

## Reverse operations

If you want to push a commit you made locally on the worker into the cloud's
checkpoint history (say, you edited a few files outside the agent flow):

```bash
cd ~/.shogo/projects/<projectId>
git add -A
git commit -m "manual: tweak landing copy"
git push origin HEAD
```

The cloud will record a `ProjectCheckpoint` for that commit with `createdBy`
set to the API key's owner, `isAutomatic: true`, and the original commit
message preserved. Studio's checkpoint panel will show it within a few
seconds.
