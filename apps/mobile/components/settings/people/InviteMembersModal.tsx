// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Modal for inviting people to a workspace by email.
 */
import { useState, useMemo } from "react";
import {
  View,
  ScrollView,
  Pressable,
  Modal,
  ActivityIndicator,
  Platform,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronDown as ChevronDownIcon, X as XIcon } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { useDomainActions } from "@shogo/shared-app/domain";
import { useBillingData } from "@shogo/shared-app/hooks";
import { useWorkspaceCollection } from "../../../contexts/domain";
import { formatUsd, PLAN_PRICING } from "../../../lib/billing-config";
import { WEB_WIDE_MIN_WIDTH } from "../../../lib/native-phone-layout";
import {
  Text,
  TextInput,
  useAccountSheetIcons,
} from "../account-sheet-chrome";

const INVITE_ICON_MAP = { X: XIcon, ChevronDown: ChevronDownIcon } as const;
const SETTINGS_WIDE_BREAKPOINT = WEB_WIDE_MIN_WIDTH;

/** RN Modal on iOS needs explicit layout + `overFullScreen`; NativeWind flex inside Modal is unreliable on device. */
const inviteMembersModalStyles = StyleSheet.create({
  nativeOverlay: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  centerRegion: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    width: "100%",
  },
  card: {
    width: "100%",
    maxWidth: 448,
    zIndex: 10,
    overflow: "visible",
  },
  cardCompact: {
    maxHeight: "92%",
  },
});

export function InviteMembersModal({
  visible,
  onClose,
  workspaceId,
  workspaceName,
  actions,
}: {
  visible: boolean;
  onClose: () => void;
  workspaceId: string;
  workspaceName: string;
  actions: ReturnType<typeof useDomainActions>;
}) {
  const { X, ChevronDown } = useAccountSheetIcons(INVITE_ICON_MAP);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const compactInviteModal = width < SETTINGS_WIDE_BREAKPOINT;
  /** iOS: never put actions as sibling below a bounded ScrollView — RCTScrollView draws a hard edge that clips/overlaps the footer. */
  const nativeCompactScrollMaxHeight = Math.min(height * 0.78, 560);

  const workspaces = useWorkspaceCollection();
  const { subscription } = useBillingData(workspaceId);
  const [emailInput, setEmailInput] = useState("");
  const [role, setRole] = useState<string>("member");
  const [showRolePicker, setShowRolePicker] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const INVITE_ROLES = [
    { value: "member", label: "Editor" },
    { value: "admin", label: "Admin" },
    { value: "viewer", label: "Viewer" },
  ];

  const selectedRoleLabel =
    INVITE_ROLES.find((r) => r.value === role)?.label || "Editor";

  const parseEmails = (input: string): string[] => {
    return input
      .split(/[,;\s]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  };

  const validEmails = parseEmails(emailInput);
  const canSubmit = validEmails.length > 0 && !isSubmitting;

  /**
   * Per-seat monthly cost on the active subscription. We only compute it when
   * there's an active paid subscription; on free/Basic the seat hint is a
   * no-op. The actual seat sync happens server-side in
   * `syncSeatsFromMembership` once an invitee accepts.
   */
  const seatHint = useMemo(() => {
    const planId = subscription?.planId?.toLowerCase?.() ?? "";
    const isPaidSeatPlan =
      planId.startsWith("pro") || planId.startsWith("business");
    if (!isPaidSeatPlan) return null;
    const pricing = planId.startsWith("business")
      ? PLAN_PRICING.business
      : PLAN_PRICING.pro;
    const interval =
      subscription?.billingInterval === "annual" ? "annual" : "monthly";
    const perSeatMonthly =
      interval === "annual" ? Math.round(pricing.annual / 12) : pricing.monthly;
    const incomingCount = validEmails.length;
    return {
      perSeatMonthly,
      incomingCount,
      planLabel: planId.startsWith("business") ? "Business" : "Pro",
    };
  }, [subscription, validEmails.length]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    let resolvedWsId = workspaceId;
    if (!resolvedWsId) {
      const ws = workspaces.all[0];
      resolvedWsId = ws?.id || "";
    }
    if (!resolvedWsId) {
      setError("Workspace not loaded yet. Please close and try again.");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      for (const email of validEmails) {
        await actions.sendInvitation({
          email,
          role: role as any,
          workspaceId: resolvedWsId,
        });
      }
      setEmailInput("");
      setRole("member");
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to send invitation"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setEmailInput("");
    setRole("member");
    setError(null);
    setShowRolePicker(false);
    onClose();
  };

  const inviteFormFields = (
    <>
      <View className="flex-row items-center justify-between mb-1">
        <Text className="text-lg font-semibold text-foreground">
          Invite members
        </Text>
        <Pressable onPress={handleClose} className="p-1 -mr-1">
          <X size={20} className="text-muted-foreground" />
        </Pressable>
      </View>

      <Text className="text-sm text-muted-foreground mb-5">
        Invite members to your workspace by email
      </Text>

      {error && (
        <View className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 mb-4">
          <Text className="text-destructive text-sm">{error}</Text>
        </View>
      )}

      <Text className="text-sm font-medium text-foreground mb-1.5">Email</Text>
      <View className="border border-border rounded-lg mb-4">
        <TextInput
          value={emailInput}
          onChangeText={(t) => {
            setEmailInput(t);
            setError(null);
          }}
          placeholder="example1@example.com, example2@example.com"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSubmitting}
          className="px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground web:outline-none"
        />
      </View>

      <Text className="text-sm font-medium text-foreground mb-1.5">Role</Text>
      <View
        className={cn("relative z-50", compactInviteModal ? "mb-4" : "mb-6")}
      >
        <Pressable
          onPress={() => setShowRolePicker(!showRolePicker)}
          className="flex-row items-center justify-between h-10 px-3 rounded-lg border border-border"
        >
          <Text className="text-sm text-foreground">{selectedRoleLabel}</Text>
          <ChevronDown size={14} className="text-muted-foreground" />
        </Pressable>
        {showRolePicker && (
          <View
            className={cn(
              "bg-background border border-border rounded-lg shadow-lg overflow-hidden",
              Platform.OS === "web"
                ? "absolute top-11 left-0 right-0 z-50"
                : "mt-1"
            )}
          >
            {INVITE_ROLES.map((r) => (
              <Pressable
                key={r.value}
                onPress={() => {
                  setRole(r.value);
                  setShowRolePicker(false);
                }}
                className={cn("px-3 py-2.5", role === r.value && "bg-accent")}
              >
                <Text
                  className={cn(
                    "text-sm",
                    role === r.value
                      ? "text-foreground font-medium"
                      : "text-foreground"
                  )}
                >
                  {r.label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {seatHint && (
        <View
          className={cn(
            "rounded-lg bg-muted/40 border border-border p-3",
            compactInviteModal ? "mb-4" : "mb-6"
          )}
        >
          <Text className="text-xs text-foreground">
            {seatHint.incomingCount > 0
              ? `Each accepted invite adds a ${
                  seatHint.planLabel
                } seat at ${formatUsd(
                  seatHint.perSeatMonthly
                )}/seat/mo (prorated immediately). Pending invites are not billed — ${
                  seatHint.incomingCount
                } seat${
                  seatHint.incomingCount === 1 ? "" : "s"
                } would be added if all accept.`
              : `Each accepted invite adds a ${
                  seatHint.planLabel
                } seat at ${formatUsd(
                  seatHint.perSeatMonthly
                )}/seat/mo (prorated immediately). Pending invites are not billed.`}
          </Text>
        </View>
      )}
    </>
  );

  const inviteFormActions = (
    <View className="flex-row gap-3">
      <Pressable
        onPress={handleClose}
        disabled={isSubmitting}
        className="flex-1 h-10 rounded-lg border border-border items-center justify-center"
      >
        <Text className="text-sm font-medium text-foreground">Cancel</Text>
      </Pressable>
      <Pressable
        onPress={handleSubmit}
        disabled={!canSubmit}
        className={cn(
          "flex-1 h-10 rounded-lg items-center justify-center",
          canSubmit ? "bg-primary" : "bg-muted"
        )}
      >
        {isSubmitting ? (
          <ActivityIndicator size="small" color="white" />
        ) : (
          <Text
            className={cn(
              "text-sm font-medium",
              canSubmit ? "text-primary-foreground" : "text-muted-foreground"
            )}
          >
            Invite
          </Text>
        )}
      </Pressable>
    </View>
  );

  const inviteModalInner = compactInviteModal ? (
    Platform.OS === "web" ? (
      <>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          nestedScrollEnabled
          className="max-h-[420px]"
        >
          {inviteFormFields}
        </ScrollView>
        {inviteFormActions}
      </>
    ) : (
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        keyboardDismissMode="interactive"
        style={{ maxHeight: nativeCompactScrollMaxHeight }}
        contentContainerClassName="pb-1"
      >
        <View>
          {inviteFormFields}
          <View className="mt-5">{inviteFormActions}</View>
        </View>
      </ScrollView>
    )
  ) : (
    <>
      {inviteFormFields}
      {inviteFormActions}
    </>
  );

  const inviteCardWeb = (
    <Pressable
      onPress={(e) => e.stopPropagation()}
      className={cn(
        "bg-background rounded-xl w-full max-w-md shadow-xl overflow-visible z-10",
        compactInviteModal ? "p-5 max-h-[92%]" : "p-6"
      )}
    >
      {inviteModalInner}
    </Pressable>
  );

  if (Platform.OS === "web") {
    return (
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={handleClose}
      >
        <Pressable
          onPress={handleClose}
          className={cn(
            "flex-1 bg-black/50 justify-center",
            compactInviteModal
              ? "px-4 py-6"
              : "items-center justify-center px-6"
          )}
        >
          {inviteCardWeb}
        </Pressable>
      </Modal>
    );
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      presentationStyle={Platform.OS === "ios" ? "overFullScreen" : undefined}
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      <View style={inviteMembersModalStyles.nativeOverlay}>
        <Pressable
          style={inviteMembersModalStyles.backdrop}
          onPress={handleClose}
        />
        <View
          style={[
            inviteMembersModalStyles.centerRegion,
            {
              paddingTop: insets.top,
              paddingBottom: insets.bottom,
              paddingHorizontal: compactInviteModal ? 16 : 24,
            },
          ]}
          pointerEvents="box-none"
        >
          <View
            style={[
              inviteMembersModalStyles.card,
              compactInviteModal ? inviteMembersModalStyles.cardCompact : null,
            ]}
            className={cn(
              "bg-background rounded-xl shadow-xl",
              compactInviteModal ? "p-5" : "p-6"
            )}
          >
            {inviteModalInner}
          </View>
        </View>
      </View>
    </Modal>
  );
}
