import { prisma } from './prisma'

/** How many names the runtime will print (mirrors account-context.ts). */
export const MAX_TEAM_WORKSPACE_NAMES = 5

/**
 * Tell the runtime which Team workspaces the caller belongs to, so the
 * Personal companion can name the one to switch to instead of trying to build
 * an app itself (SHO-221).
 *
 * Stamped on Personal chats only — a Team-workspace chat already builds in
 * place. Mutates `parsedBody` in place and always overwrites whatever the
 * client sent. Best-effort: a lookup failure leaves the field unset and the
 * turn proceeds (the agent then falls back to "your Team workspace").
 */
export async function stampTeamWorkspaceNames(
  parsedBody: { teamWorkspaceNames?: unknown },
  userId: string | undefined,
): Promise<void> {
  if (!userId) {
    delete parsedBody.teamWorkspaceNames
    return
  }
  try {
    const members = await prisma.member.findMany({
      where: { userId, projectId: null, workspace: { kind: 'team' } },
      orderBy: { createdAt: 'asc' },
      take: MAX_TEAM_WORKSPACE_NAMES,
      select: { workspace: { select: { name: true } } },
    })
    parsedBody.teamWorkspaceNames = members
      .map((m) => m.workspace?.name)
      .filter((name): name is string => typeof name === 'string' && name.trim() !== '')
  } catch (err: any) {
    delete parsedBody.teamWorkspaceNames
    console.warn(`[stampTeamWorkspaceNames] lookup failed for ${userId}:`, err?.message ?? err)
  }
}
