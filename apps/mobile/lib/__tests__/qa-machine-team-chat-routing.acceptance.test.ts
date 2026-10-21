// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-87 acceptance — while a paired desktop's own workspace is open, the whole
 * of that workspace's team chat comes from the machine.
 *
 * The screens do not choose a host: they build `/api/workspaces/<id>/...` from
 * the cloud workspace id they already have, and the interceptor decides. So the
 * contract is "every workspace-scoped team-chat path `teamChatApi()` can build
 * is routed to the machine when a machine workspace is in view" — read as a
 * whole from the client's own source, because a hand-maintained allow-list is
 * exactly the thing that loses an entry the day someone adds a screen.
 *
 * The counterpart is the second block: the workspace *list* and the cloud-only
 * families stay on cloud, machine open or not.
 *
 *   bun test apps/mobile/lib/__tests__/qa-machine-team-chat-routing.acceptance.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rewriteMachineWorkspacePath, shouldRouteToRemote } from "../../../../packages/shared-app/src/services/remote-http-interceptor";

const CLOUD_WORKSPACE = "cloud-personal-ws";
const LOCAL_WORKSPACE = "samsara-local-ws";

/**
 * Every `/api/workspaces/:id/...` path `teamChatApi()` builds.
 *
 * Read out of the module rather than listed here: the point of the check is
 * that nobody has to remember to update a list when they add a call.
 */
function teamChatWorkspacePaths(): string[] {
  const source = readFileSync(join(import.meta.dir, "..", "team-chat-api.ts"), "utf8");
  const paths = new Set<string>();
  for (const match of source.matchAll(/ws\(workspaceId\)\}([^`'"\s]*)/g)) {
    // `${qs}` is the caller's query string, so it is not part of the path; any
    // other `${…}` is one path segment (`/agents/${key}/buddy`), which a
    // concrete id stands in for here.
    const raw = (match[1] ?? "")
      .replace(/\$\{qs\}/g, "")
      .replace(/\$\{[^}]*\}/g, "x1")
      .split("?")[0] ?? "";
    if (!raw) continue;
    paths.add(`/api/workspaces/${CLOUD_WORKSPACE}${raw}`);
  }
  return [...paths].sort();
}

/**
 * Team-chat endpoints that legitimately stay on the cloud even while a machine
 * workspace is open: a Slack/Discord/Teams install is configured cloud-side for
 * a cloud workspace, and a machine workspace has no install to show.
 */
const CLOUD_ONLY_TEAM_CHAT = [/\/chat-installations(\/|$)/];

describe("SHO-87 — a machine workspace's team chat reads the machine", () => {
  test("the client has workspace-scoped team-chat paths to check", () => {
    // Guards the extractor itself: if this drops to a couple of entries the
    // regex has drifted and the loop below proves nothing.
    expect(teamChatWorkspacePaths().length).toBeGreaterThan(15);
  });

  test("every workspace-scoped team-chat path is routed to the machine", () => {
    const unrouted = teamChatWorkspacePaths().filter(
      (path) =>
        !CLOUD_ONLY_TEAM_CHAT.some((pattern) => pattern.test(path)) &&
        !shouldRouteToRemote(path, { machineWorkspaceId: LOCAL_WORKSPACE }),
    );

    // The message list, composing a message and presence are one surface: a
    // team chat that reads conversations from the machine but members, presence
    // or the inbox from the cloud workspace is two workspaces in one screen.
    expect(unrouted).toEqual([]);
  });

  test("the machine is told its own workspace id, not the cloud one", () => {
    // The companion half of the routing decision: a routed path the desktop
    // cannot resolve is a 404, so the two must be decided together.
    expect(rewriteMachineWorkspacePath(`/api/workspaces/${CLOUD_WORKSPACE}/conversations`, LOCAL_WORKSPACE)).toBe(
      `/api/workspaces/${LOCAL_WORKSPACE}/conversations`,
    );
    expect(
      rewriteMachineWorkspacePath(`/api/workspaces/${CLOUD_WORKSPACE}/conversation-messages`, LOCAL_WORKSPACE),
    ).toBe(`/api/workspaces/${LOCAL_WORKSPACE}/conversation-messages`);
  });
});

describe("SHO-87 — cloud-only surfaces keep going to cloud", () => {
  const cloudOnly = [
    "/api/workspaces",
    `/api/workspaces/${CLOUD_WORKSPACE}/analytics/overview`,
    `/api/workspaces/${CLOUD_WORKSPACE}/analytics/usage-summary`,
    "/api/billing/subscription",
    "/api/auth/session",
  ];

  test("a machine workspace does not swallow the workspace list, analytics or billing", () => {
    expect(
      cloudOnly.filter((path) => shouldRouteToRemote(path, { machineWorkspaceId: LOCAL_WORKSPACE })),
    ).toEqual([]);
  });

  test("with no machine in view nothing workspace-scoped moves", () => {
    expect(
      teamChatWorkspacePaths().filter((path) => shouldRouteToRemote(path)),
    ).toEqual([]);
  });
});
