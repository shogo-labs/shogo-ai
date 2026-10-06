// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Anchored popovers for a member row: the "···" actions menu and the inline
 * role dropdown. Actions the viewer can't take are shown disabled with the
 * reason underneath instead of being hidden.
 */
import { useState, type ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  LogOut,
  MoreHorizontal,
  Trash2,
  User,
  Shield,
} from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from "@/components/ui/popover";
import { Text } from "../account-sheet-chrome";
import {
  ROLE_DISPLAY,
  assignableRoles,
  canChangeRole,
  canLeave,
  canRemove,
  type WorkspaceRole,
} from "./member-permissions";

const IS_TOUCH = Platform.OS === "ios" || Platform.OS === "android";

function MenuItem({
  icon,
  label,
  reason,
  destructive,
  disabled,
  onPress,
  testID,
}: {
  icon: ReactNode;
  label: string;
  reason?: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="menuitem"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      className={cn(
        "flex-row items-start gap-2.5 px-3 py-2.5 active:bg-muted",
        disabled && "opacity-50"
      )}
    >
      <View className="pt-0.5">{icon}</View>
      <View className="flex-1 min-w-0">
        <Text
          className={cn(
            "text-sm",
            destructive && !disabled ? "text-destructive" : "text-foreground"
          )}
        >
          {label}
        </Text>
        {disabled && reason ? (
          <Text className="text-xs text-muted-foreground mt-0.5">{reason}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function RoleOptions({
  roles,
  current,
  onSelect,
}: {
  roles: WorkspaceRole[];
  current?: string;
  onSelect: (role: WorkspaceRole) => void;
}) {
  return (
    <>
      {roles.map((role) => (
        <Pressable
          key={role}
          testID={`role-option-${role}`}
          accessibilityRole="menuitem"
          onPress={() => onSelect(role)}
          className="flex-row items-center justify-between gap-3 px-3 py-2.5 active:bg-muted"
        >
          <Text
            className={cn(
              "text-sm text-foreground",
              current === role && "font-medium"
            )}
          >
            {ROLE_DISPLAY[role]}
          </Text>
          {current === role ? (
            <Check size={14} className="text-foreground" />
          ) : null}
        </Pressable>
      ))}
    </>
  );
}

const TRIGGER_HIT_SLOP = IS_TOUCH
  ? { top: 6, bottom: 6, left: 6, right: 6 }
  : undefined;

export interface MemberActionsMenuProps {
  memberName: string;
  targetRole: string;
  isSelf: boolean;
  viewerRole?: string | null;
  /** Number of workspaces the current user belongs to (gates "Leave workspace"). */
  workspaceCount: number;
  /** Owners in this workspace excluding the current user. */
  otherOwnerCount: number;
  onViewDetails: () => void;
  onChangeRole: (role: WorkspaceRole) => void;
  onRemove: () => void;
  onLeave: () => void;
}

export function MemberActionsMenu({
  memberName,
  targetRole,
  isSelf,
  viewerRole,
  workspaceCount,
  otherOwnerCount,
  onViewDetails,
  onChangeRole,
  onRemove,
  onLeave,
}: MemberActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<"actions" | "roles">("actions");

  const close = () => {
    setIsOpen(false);
    setView("actions");
  };
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  const roleRule = canChangeRole({ viewerRole, targetRole, isSelf });
  const removeRule = canRemove({ viewerRole, targetRole, isSelf });
  const leaveRule = canLeave({ viewerRole, workspaceCount, otherOwnerCount });
  const roles = assignableRoles(viewerRole);

  return (
    <Popover
      placement="bottom right"
      isOpen={isOpen}
      onOpen={() => setIsOpen(true)}
      onClose={close}
      trigger={(triggerProps) => (
        <Pressable
          {...triggerProps}
          testID={`member-actions-${memberName}`}
          accessibilityLabel={`Actions for ${memberName}`}
          hitSlop={TRIGGER_HIT_SLOP}
          onPress={() => (isOpen ? close() : setIsOpen(true))}
          className="items-center justify-center rounded-lg min-w-[44px] min-h-[44px] active:bg-muted/80"
        >
          <MoreHorizontal size={18} className="text-muted-foreground" />
        </Pressable>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent className="p-0 min-w-[220px] max-w-[280px]">
        <PopoverBody>
          {view === "actions" ? (
            <>
              <MenuItem
                testID="member-action-details"
                icon={<User size={14} className="text-muted-foreground" />}
                label="View details"
                onPress={run(onViewDetails)}
              />
              {isSelf ? (
                <>
                  <View className="h-px bg-border my-1" />
                  <MenuItem
                    testID="member-action-leave"
                    icon={
                      <LogOut
                        size={14}
                        className={
                          leaveRule.allowed
                            ? "text-destructive"
                            : "text-muted-foreground"
                        }
                      />
                    }
                    label="Leave workspace"
                    reason={leaveRule.reason}
                    disabled={!leaveRule.allowed}
                    destructive
                    onPress={run(onLeave)}
                  />
                </>
              ) : viewerRole === "owner" || viewerRole === "admin" ? (
                <>
                  <MenuItem
                    testID="member-action-role"
                    icon={<Shield size={14} className="text-muted-foreground" />}
                    label="Change role"
                    reason={roleRule.reason}
                    disabled={!roleRule.allowed}
                    onPress={() => setView("roles")}
                  />
                  <View className="h-px bg-border my-1" />
                  <MenuItem
                    testID="member-action-remove"
                    icon={
                      <Trash2
                        size={14}
                        className={
                          removeRule.allowed
                            ? "text-destructive"
                            : "text-muted-foreground"
                        }
                      />
                    }
                    label="Remove from workspace"
                    reason={removeRule.reason}
                    disabled={!removeRule.allowed}
                    destructive
                    onPress={run(onRemove)}
                  />
                </>
              ) : null}
            </>
          ) : (
            <>
              <Pressable
                onPress={() => setView("actions")}
                className="flex-row items-center gap-1.5 px-3 py-2.5 active:bg-muted"
              >
                <ChevronLeft size={14} className="text-muted-foreground" />
                <Text className="text-xs font-medium text-muted-foreground">
                  Role for {memberName}
                </Text>
              </Pressable>
              <RoleOptions
                roles={roles}
                current={targetRole}
                onSelect={(role) => {
                  close();
                  if (role !== targetRole) onChangeRole(role);
                }}
              />
            </>
          )}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}

/** Inline role control: a dropdown for managers who may change this role, a plain label otherwise. */
export function RoleDropdown({
  memberName,
  targetRole,
  isSelf,
  viewerRole,
  onChangeRole,
}: {
  memberName: string;
  targetRole: string;
  isSelf: boolean;
  viewerRole?: string | null;
  onChangeRole: (role: WorkspaceRole) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const rule = canChangeRole({ viewerRole, targetRole, isSelf });
  const label = ROLE_DISPLAY[targetRole] || targetRole;

  if (!rule.allowed) {
    return (
      <Text className="text-sm text-foreground capitalize">{label}</Text>
    );
  }

  return (
    <Popover
      placement="bottom left"
      isOpen={isOpen}
      onOpen={() => setIsOpen(true)}
      onClose={() => setIsOpen(false)}
      trigger={(triggerProps) => (
        <Pressable
          {...triggerProps}
          testID={`role-dropdown-${memberName}`}
          accessibilityLabel={`Change role for ${memberName}`}
          hitSlop={TRIGGER_HIT_SLOP}
          onPress={() => setIsOpen((o) => !o)}
          className="flex-row items-center gap-1 py-1 -mx-1 px-1 rounded-md active:bg-muted/80"
        >
          <Text className="text-sm text-foreground capitalize">{label}</Text>
          <ChevronDown size={12} className="text-muted-foreground" />
        </Pressable>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent className="p-0 min-w-[160px]">
        <PopoverBody>
          <RoleOptions
            roles={assignableRoles(viewerRole)}
            current={targetRole}
            onSelect={(role) => {
              setIsOpen(false);
              if (role !== targetRole) onChangeRole(role);
            }}
          />
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}
