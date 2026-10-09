// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Access" block shown at the top of the member detail sheet: role picker plus
 * the remove / leave control, gated by the shared permission rules. Uses inline
 * buttons rather than popovers because it renders inside a modal sheet.
 */
import { Pressable, View } from "react-native";
import { Button, cn } from "@shogo/shared-ui/primitives";
import { Text } from "../account-sheet-chrome";
import {
  ROLE_DISPLAY,
  assignableRoles,
  canChangeRole,
  canLeave,
  canRemove,
  type WorkspaceRole,
} from "./member-permissions";

export interface MemberAccessSectionProps {
  memberName: string;
  role: string;
  isSelf: boolean;
  viewerRole?: string | null;
  workspaceCount: number;
  otherOwnerCount: number;
  onChangeRole: (role: WorkspaceRole) => void;
  onRemove: () => void;
  onLeave: () => void;
}

export function MemberAccessSection({
  memberName,
  role,
  isSelf,
  viewerRole,
  workspaceCount,
  otherOwnerCount,
  onChangeRole,
  onRemove,
  onLeave,
}: MemberAccessSectionProps) {
  const roleRule = canChangeRole({ viewerRole, targetRole: role, isSelf });
  const removeRule = canRemove({ viewerRole, targetRole: role, isSelf });
  const leaveRule = canLeave({ viewerRole, workspaceCount, otherOwnerCount });
  const canManage = viewerRole === "owner" || viewerRole === "admin";

  // Nothing to manage: a member/viewer looking at someone else.
  if (!isSelf && !canManage) return null;

  return (
    <View className="gap-3 rounded-xl border border-border bg-card p-4">
      <Text className="text-sm font-semibold text-foreground">Access</Text>

      <View className="gap-2">
        <Text className="text-xs text-muted-foreground">Role</Text>
        {roleRule.allowed ? (
          <View className="flex-row flex-wrap gap-2">
            {assignableRoles(viewerRole).map((r) => (
              <Pressable
                key={r}
                testID={`sheet-role-${r}`}
                accessibilityRole="button"
                accessibilityState={{ selected: role === r }}
                onPress={() => {
                  if (r !== role) onChangeRole(r);
                }}
                className={cn(
                  "rounded-md border px-3 py-2",
                  role === r ? "border-foreground bg-muted" : "border-border"
                )}
              >
                <Text className="text-xs font-medium text-foreground">
                  {ROLE_DISPLAY[r]}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <View>
            <Text className="text-sm text-foreground">
              {ROLE_DISPLAY[role] || role}
            </Text>
            {roleRule.reason && !isSelf ? (
              <Text className="mt-0.5 text-xs text-muted-foreground">
                {roleRule.reason}
              </Text>
            ) : null}
          </View>
        )}
      </View>

      {isSelf ? (
        <View className="gap-1.5 border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={!leaveRule.allowed}
            onPress={onLeave}
            testID="sheet-leave"
          >
            Leave workspace
          </Button>
          {!leaveRule.allowed && leaveRule.reason ? (
            <Text className="text-xs text-muted-foreground">
              {leaveRule.reason}
            </Text>
          ) : null}
        </View>
      ) : (
        <View className="gap-1.5 border-t border-border pt-3">
          <Button
            variant="destructive"
            size="sm"
            disabled={!removeRule.allowed}
            onPress={onRemove}
            testID="sheet-remove"
          >
            {`Remove ${memberName} from workspace`}
          </Button>
          {!removeRule.allowed && removeRule.reason ? (
            <Text className="text-xs text-muted-foreground">
              {removeRule.reason}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}
