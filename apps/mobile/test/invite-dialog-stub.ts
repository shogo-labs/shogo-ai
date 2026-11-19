// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The `useInviteDialog` / `usePermissions` stubs the team-chat suites install
 * (SHO-454).
 *
 * `mock.module` is process-wide, so a per-file closure is shadowed by whichever
 * suite registered first — a test that sets its own `canInvite` then reads the
 * other file's value. Both suites read this one holder instead.
 */
export const inviteStub = {
  canInvite: false,
  opened: [] as Array<{ workspaceId?: string | null; emails?: string[] }>,
  reset() {
    this.canInvite = false
    this.opened.length = 0
  },
}

export function inviteDialogContextStub() {
  return {
    useInviteDialog: () => ({
      openInviteDialog: (workspaceId?: string | null, opts?: { emails?: string[] }) =>
        void inviteStub.opened.push({ workspaceId, emails: opts?.emails }),
      closeInviteDialog: () => {},
    }),
    useInviteDialogOptional: () => null,
  }
}

export function invitePermissionsStub() {
  return {
    usePermissions: () => ({ can: () => false, canInvite: inviteStub.canInvite, loading: false }),
  }
}
