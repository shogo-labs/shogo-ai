// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-334 acceptance — the DM sweep can be read per platform.
 *
 * Shogo Engage's 2026-11-04 sweep asked `social_media` for `action: "inbox"`,
 * `kind: "dms"`, `platform: "tiktok"` and got Instagram threads back: the tool
 * built `/social/inbox?limit=N` and dropped `params.platform`, which the API
 * had supported all along.
 *
 * This file walks the whole hop — the real `social_media` tool, a real HTTP
 * call, the real Hono agent router, the real SQLite database — so a query
 * string that silently loses `platform` fails here, not in a sweep.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setupChannelsTestDb } from "../../../__tests__/helpers/channels-test-db";

setupChannelsTestDb();

const { prisma } = await import("../../../lib/prisma");
const { agentSocialRoutes } = await import("../../../routes/social");
const { createTools } = await import("@shogo/agent-runtime/src/gateway-tools");

const db = prisma as any;

const app = new Hono();
app.route(
  "/api/internal",
  agentSocialRoutes({
    authorize: async (c: any) => ({ workspaceId: c.req.param("workspaceId") }),
  }),
);

const suffix = crypto.randomUUID().slice(0, 8);
let server: ReturnType<typeof Bun.serve>;
let workspaceDir = "";
let workspaceId = "";
let profileId = "";

const config = {
  // The shape a management-only workspace has: lookups are off, the connected
  // inboxes are still ours to read.
  socialManagementEnabled: true,
  socialMediaEnabled: false,
  socialInstagramEnabled: true,
  socialTiktokEnabled: true,
  channels: [],
  model: { provider: "anthropic", name: "claude-sonnet-4-5" },
};

function makeCtx(overrides: Record<string, unknown> = {}): any {
  return {
    workspaceDir,
    workspaceId,
    channels: new Map(),
    config: { ...config },
    projectId: "proj-sho334",
    ...overrides,
  };
}

async function run(params: Record<string, any>, ctx = makeCtx()) {
  const tool = createTools(ctx).find(
    (entry: any) => entry.name === "social_media",
  );
  if (!tool) throw new Error("social_media tool is not registered");
  const result = await (tool as any).execute("call-1", params);
  return (result as any).details ?? result;
}

async function seedConversation(
  platform: string,
  accountId: string | null,
  input: { name: string; unread: number },
) {
  return db.socialConversation.create({
    data: {
      workspaceId,
      accountId,
      zernioConversationId: `provider_conv_${platform}_${input.name}_${suffix}`,
      platform,
      participantId: `participant_${input.name}`,
      participantName: input.name,
      status: "active",
      unreadCount: input.unread,
      lastMessageAt: new Date(),
      lastMessagePreview: "hi",
    },
  });
}

let igAccount: any;
let ttAccount: any;

beforeAll(async () => {
  server = Bun.serve({ port: 0, fetch: app.fetch });
  process.env.SHOGO_API_URL = `http://localhost:${server.port}`;

  workspaceDir = mkdtempSync(join(tmpdir(), "shogo-sho334-"));
  const user = await db.user.create({
    data: { name: "owner", email: `sho334-owner-${suffix}@example.com` },
  });
  const workspace = await db.workspace.create({
    data: { name: "SHO-334", slug: `sho334-${suffix}`, kind: "team" },
  });
  workspaceId = workspace.id;
  await db.member.create({
    data: { workspaceId, userId: user.id, role: "owner", projectId: null },
  });

  const profile = await db.socialProfile.create({
    data: {
      workspaceId,
      localWorkspaceId: "",
      zernioProfileId: `provider_profile_${suffix}`,
      externalId: `ext_${suffix}`,
      name: "SHO-334",
    },
  });
  profileId = profile.id;

  igAccount = await db.socialAccount.create({
    data: {
      workspaceId,
      profileId,
      zernioAccountId: `provider_ig_${suffix}`,
      platform: "instagram",
      username: "acme.ig",
      isActive: true,
    },
  });
  ttAccount = await db.socialAccount.create({
    data: {
      workspaceId,
      profileId,
      zernioAccountId: `provider_tt_${suffix}`,
      platform: "tiktok",
      username: "acme.tt",
      isActive: true,
    },
  });

  await seedConversation("instagram", igAccount.id, {
    name: "ada_ig",
    unread: 2,
  });
  await seedConversation("instagram", igAccount.id, {
    name: "dave_ig",
    unread: 0,
  });
  await seedConversation("tiktok", ttAccount.id, {
    name: "grace_tt",
    unread: 1,
  });
  await seedConversation("tiktok", ttAccount.id, {
    name: "linus_tt",
    unread: 0,
  });
});

afterAll(async () => {
  server?.stop(true);
  rmSync(workspaceDir, { recursive: true, force: true });
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
});

describe("AC1 — a DM sweep can be read per platform through the real route", () => {
  test("platform=tiktok returns only TikTok threads", async () => {
    const result = await run({
      action: "inbox",
      kind: "dms",
      platform: "tiktok",
    });

    expect(result.error).toBeUndefined();
    expect(result.platform).toBe("tiktok");
    expect(result.count).toBe(2);
    expect(result.conversations.map((row: any) => row.platform)).toEqual([
      "tiktok",
      "tiktok",
    ]);
    expect(
      result.conversations.map((row: any) => row.participant).sort(),
    ).toEqual(["grace_tt", "linus_tt"]);
  });

  test("platform=instagram returns only Instagram threads", async () => {
    const result = await run({
      action: "inbox",
      kind: "dms",
      platform: "instagram",
    });

    expect(result.platform).toBe("instagram");
    expect(result.count).toBe(2);
    expect(result.conversations.map((row: any) => row.platform)).toEqual([
      "instagram",
      "instagram",
    ]);
  });

  test("omitting platform keeps the combined list", async () => {
    const result = await run({ action: "inbox", kind: "dms" });

    expect(result.platform).toBeUndefined();
    expect(result.count).toBe(4);
    expect(
      new Set(result.conversations.map((row: any) => row.platform)),
    ).toEqual(new Set(["instagram", "tiktok"]));
    expect(result.unread).toBe(3);
  });

  test("the platform narrows unread_only too", async () => {
    const result = await run({
      action: "inbox",
      kind: "dms",
      platform: "tiktok",
      unread_only: true,
    });

    expect(result.count).toBe(1);
    expect(result.conversations[0].participant).toBe("grace_tt");
    expect(result.unread).toBe(1);
  });

  test("a platform with no threads is an empty list, never the other platform", async () => {
    await db.socialConversation.deleteMany({
      where: { workspaceId, platform: "instagram" },
    });
    try {
      const result = await run({
        action: "inbox",
        kind: "dms",
        platform: "instagram",
      });
      expect(result.count).toBe(0);
      expect(result.conversations).toEqual([]);
    } finally {
      await seedConversation("instagram", igAccount.id, {
        name: "ada_ig",
        unread: 2,
      });
      await seedConversation("instagram", igAccount.id, {
        name: "dave_ig",
        unread: 0,
      });
    }
  });
});

describe("AC2 — an unusable platform is refused, and nothing is read", () => {
  test("an unknown platform is refused", async () => {
    const result = await run({
      action: "inbox",
      kind: "dms",
      platform: "twitter",
    });

    expect(result.error).toContain('Platform "twitter" is not enabled');
    expect(result.conversations).toBeUndefined();
  });

  test("a platform this workspace turned off is refused, and the enabled ones are named", async () => {
    const ctx = makeCtx({ config: { ...config, socialTiktokEnabled: false } });
    const result = await run(
      { action: "inbox", kind: "dms", platform: "tiktok" },
      ctx,
    );

    expect(result.error).toContain('Platform "tiktok" is not enabled');
    expect(result.error).toContain("Enabled platforms: instagram");
    expect(result.conversations).toBeUndefined();
  });
});
