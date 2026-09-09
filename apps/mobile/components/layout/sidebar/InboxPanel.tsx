// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Inbox, X } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { isInvitationExpired } from "../../../lib/api";
import { NativePhoneSheet } from "../../phone/NativePhoneSheet";

export type InviteProcessingState = {
  id: string;
  action: "accept" | "decline";
} | null;

export interface InboxPanelProps {
  visible: boolean;
  isWide: boolean;
  pendingInvites: any[];
  processingInvite: InviteProcessingState;
  onClose: () => void;
  onAccept: (invite: any) => void | Promise<void>;
  onDecline: (invite: any) => void | Promise<void>;
}

function InboxContent({
  pendingInvites,
  processingInvite,
  onClose,
  onAccept,
  onDecline,
}: Pick<
  InboxPanelProps,
  "pendingInvites" | "processingInvite" | "onClose" | "onAccept" | "onDecline"
>) {
  return (
    <>
      <View className="flex-row items-center justify-between px-4 pt-4 pb-2">
        <Text className="text-base font-semibold text-card-foreground">
          Inbox
        </Text>
        <Pressable
          onPress={onClose}
          className="rounded-md p-1 active:bg-muted"
          accessibilityLabel="Close inbox"
        >
          <X size={16} className="text-muted-foreground" />
        </Pressable>
      </View>
      {pendingInvites.length === 0 ? (
        <View className="items-center gap-2 px-4 pb-5 pt-6">
          <Inbox size={28} className="text-muted-foreground" />
          <Text className="text-sm font-medium text-card-foreground">
            No messages or invites pending.
          </Text>
          <Text className="text-center text-xs text-muted-foreground">
            Workspace and project invitations will appear here
          </Text>
        </View>
      ) : (
        <ScrollView className="max-h-[300px]">
          <Text className="px-4 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Invitations
          </Text>
          {pendingInvites.map((invite: any) => {
            const expired = isInvitationExpired(invite);
            const isAccepting =
              processingInvite?.id === invite.id &&
              processingInvite?.action === "accept";
            const isDeclining =
              processingInvite?.id === invite.id &&
              processingInvite?.action === "decline";
            return (
              <View
                key={invite.id}
                className="border-t border-border px-4 py-3"
              >
                <View className="mb-0.5 flex-row items-center justify-between">
                  <Text className="text-sm font-medium text-card-foreground">
                    {invite.workspace?.name ||
                      invite.workspaceName ||
                      "Workspace"}
                  </Text>
                  <View className="flex-row items-center gap-1.5">
                    {expired ? (
                      <View className="rounded bg-amber-100 px-1.5 py-0.5 dark:bg-amber-950/40">
                        <Text className="text-[10px] text-amber-700 dark:text-amber-300">
                          Expired
                        </Text>
                      </View>
                    ) : null}
                    <View className="rounded bg-muted px-1.5 py-0.5">
                      <Text className="text-[10px] capitalize text-muted-foreground">
                        {invite.role}
                      </Text>
                    </View>
                  </View>
                </View>
                <Text className="mb-2.5 text-xs text-muted-foreground">
                  {expired
                    ? "Expired invitation. Ask for a new invite to join."
                    : "Invited to join this workspace"}
                </Text>
                <View className="flex-row gap-2">
                  <Pressable
                    disabled={expired || processingInvite?.id === invite.id}
                    onPress={() => onAccept(invite)}
                    className={cn(
                      "h-8 flex-1 items-center justify-center rounded-md",
                      expired ? "bg-muted" : "bg-primary",
                      (expired || processingInvite?.id === invite.id) &&
                        "opacity-50",
                    )}
                  >
                    {isAccepting ? (
                      <ActivityIndicator size="small" color="white" />
                    ) : (
                      <Text
                        className={cn(
                          "text-xs font-medium",
                          expired
                            ? "text-muted-foreground"
                            : "text-primary-foreground",
                        )}
                      >
                        {expired ? "Expired" : "Accept"}
                      </Text>
                    )}
                  </Pressable>
                  <Pressable
                    disabled={processingInvite?.id === invite.id}
                    onPress={() => onDecline(invite)}
                    className={cn(
                      "h-8 flex-1 items-center justify-center rounded-md border border-border",
                      processingInvite?.id === invite.id && "opacity-50",
                    )}
                  >
                    {isDeclining ? (
                      <ActivityIndicator size="small" />
                    ) : (
                      <Text className="text-xs font-medium text-card-foreground">
                        {expired ? "Dismiss" : "Decline"}
                      </Text>
                    )}
                  </Pressable>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}
    </>
  );
}

export function InboxPanel({
  visible,
  isWide,
  pendingInvites,
  processingInvite,
  onClose,
  onAccept,
  onDecline,
}: InboxPanelProps) {
  const content = (
    <InboxContent
      pendingInvites={pendingInvites}
      processingInvite={processingInvite}
      onClose={onClose}
      onAccept={onAccept}
      onDecline={onDecline}
    />
  );

  if (!isWide) {
    return (
      <NativePhoneSheet
        visible={visible}
        onClose={onClose}
        animationType="slide"
      >
        {content}
      </NativePhoneSheet>
    );
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <Pressable className="flex-1" onPress={onClose}>
        <View className="absolute bottom-16 left-[220px] w-[340px] rounded-xl border border-border bg-card shadow-2xl">
          {content}
        </View>
      </Pressable>
    </Modal>
  );
}
