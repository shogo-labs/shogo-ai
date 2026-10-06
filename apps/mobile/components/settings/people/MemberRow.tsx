// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Pressable, View } from "react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { Text } from "../account-sheet-chrome";
import { MemberActionsMenu, RoleDropdown } from "./MemberActionsMenu";
import {
  ROLE_COLORS,
  ROLE_DISPLAY,
  type WorkspaceRole,
} from "./member-permissions";

/** Column widths shared by the list header and rows on wide layouts. */
export const MEMBER_COL_ROLE = "w-[140px]";
export const MEMBER_COL_USAGE = "w-[110px]";
export const MEMBER_COL_ACTIONS = "w-11 items-center justify-center";

export interface MemberRowProps {
  name: string;
  email: string;
  role: string;
  isSelf: boolean;
  viewerRole?: string | null;
  /** Narrow layout: stack role + usage under the name instead of using columns. */
  compact: boolean;
  /** Pre-formatted usage figure, or "—" when the viewer can't see it. */
  usageLabel: string;
  workspaceCount: number;
  otherOwnerCount: number;
  onViewDetails: () => void;
  onChangeRole: (role: WorkspaceRole) => void;
  onRemove: () => void;
  onLeave: () => void;
}

export function MemberRow(props: MemberRowProps) {
  const {
    name,
    email,
    role,
    isSelf,
    viewerRole,
    compact,
    usageLabel,
    workspaceCount,
    otherOwnerCount,
    onViewDetails,
    onChangeRole,
    onRemove,
    onLeave,
  } = props;
  const initial = (name || "M")[0]?.toUpperCase();

  const identity = (
    <Pressable
      onPress={onViewDetails}
      accessibilityRole="button"
      accessibilityLabel={`View details for ${name}`}
      className="flex-row items-center gap-3 flex-1 min-w-0"
    >
      <View
        className={cn(
          "h-9 w-9 rounded-full items-center justify-center shrink-0",
          ROLE_COLORS[role] || "bg-primary"
        )}
      >
        <Text className="text-xs font-semibold text-white">{initial}</Text>
      </View>
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-1 flex-wrap">
          <Text
            className="text-sm font-medium text-foreground"
            numberOfLines={1}
          >
            {name}
          </Text>
          {isSelf ? (
            <Text className="text-sm text-muted-foreground">(you)</Text>
          ) : null}
        </View>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {email}
        </Text>
      </View>
    </Pressable>
  );

  const roleControl = (
    <RoleDropdown
      memberName={name}
      targetRole={role}
      isSelf={isSelf}
      viewerRole={viewerRole}
      onChangeRole={onChangeRole}
    />
  );

  const actions = (
    <View className={MEMBER_COL_ACTIONS}>
      <MemberActionsMenu
        memberName={name}
        targetRole={role}
        isSelf={isSelf}
        viewerRole={viewerRole}
        workspaceCount={workspaceCount}
        otherOwnerCount={otherOwnerCount}
        onViewDetails={onViewDetails}
        onChangeRole={onChangeRole}
        onRemove={onRemove}
        onLeave={onLeave}
      />
    </View>
  );

  if (compact) {
    return (
      <View
        testID={`member-row-${name}`}
        className="flex-row items-center gap-2 pl-4 pr-1 py-3 border-b border-border"
      >
        <View className="flex-1 min-w-0 gap-2">
          {identity}
          <View className="flex-row items-center gap-4 pl-12">
            {roleControl}
            <Text className="text-xs text-muted-foreground tabular-nums">
              {usageLabel === "—" ? "" : `${usageLabel} used`}
            </Text>
          </View>
        </View>
        {actions}
      </View>
    );
  }

  return (
    <View
      testID={`member-row-${name}`}
      className="flex-row items-center gap-4 pl-4 pr-2 py-3 border-b border-border"
    >
      {identity}
      <View className={MEMBER_COL_ROLE}>{roleControl}</View>
      <View className={cn(MEMBER_COL_USAGE, "items-end")}>
        <Text className="text-sm text-foreground tabular-nums">
          {usageLabel}
        </Text>
      </View>
      {actions}
    </View>
  );
}

export function RoleBadge({ role }: { role: string }) {
  return (
    <View className="self-start rounded-full bg-muted px-2 py-0.5">
      <Text className="text-xs font-medium text-foreground">
        {ROLE_DISPLAY[role] || role}
      </Text>
    </View>
  );
}
