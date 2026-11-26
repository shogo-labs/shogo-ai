// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Which commit a publish ships.
 *
 * `Project.publishedCommitSha` records the last publish that **succeeded**, which
 * is the wrong question at publish time. A first publish has no value yet, so it
 * could not build an image at all and was refused forever — the commit it wanted
 * is written by the publish that has to succeed first (QA round 7). And once a
 * project had published, every later publish labelled its image with the
 * *previous* publish's commit, one code change behind what it shipped (QA round 8).
 *
 * The pod owns the project's repo, so the commit being published is its HEAD.
 * Resolving it before the environment is configured — which is where the
 * per-commit image is built — is what makes the first publish able to build a
 * `pg` image of its own code, and what keeps the image, the deployment record and
 * the tag naming one commit.
 *
 * Best-effort by design: a project with no live pod (a static-only project, an
 * uploaded bundle, or a runtime that cannot flush) falls back to the recorded
 * commit, which is what the publish read before.
 */
export async function resolvePublishCommitSha(input: {
  /** Static publishes have no server to build an image for. */
  serverBacked: boolean
  /** HEAD of the pod's repo after a flush, or null when there is no pod/repo. */
  flushHead: () => Promise<{ sha: string | null } | null>
  /** `Project.publishedCommitSha` — the last publish that succeeded. */
  recordedCommitSha: () => Promise<string | null>
}): Promise<string | null> {
  if (input.serverBacked) {
    const head = await input.flushHead().catch(() => null)
    if (head?.sha) return head.sha
  }
  return input.recordedCommitSha().catch(() => null)
}
