// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Props for the account menu. Profile, Appearance, Creator, Admin, and
 * Sign out now live in the rail avatar menu (`ProfileMenuContent`).
 * Native Account uses NativeAccountPersonalGroups for the same destinations.
 */

export interface UserMenuProps {
  user: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
  } | null;
  onSignOut: () => void;
  onNavigate: (href: string) => void;
  isSuperAdmin?: boolean;
  isWide?: boolean;
  bottomInset?: number;
  collapsed?: boolean;
}
