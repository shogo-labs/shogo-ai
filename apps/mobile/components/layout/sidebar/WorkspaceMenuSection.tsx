// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace identity, usage, and switcher. Native Account and the web
 * popover share this tree; `isNative` only switches density and grouping.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Linking, Platform, Pressable, Text, useWindowDimensions, View } from "react-native";
import { Cloud, CloudOff, ExternalLink, LogIn, LogOut, Plus, Settings, Sparkles, Users, Zap } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { usePostHogSafe } from "../../../contexts/posthog";
import { getPlanDisplayName } from "../../../lib/billing-config";
import { EVENTS, trackEvent } from "../../../lib/analytics";
import { CompactUsageWindows } from "../../billing/UsageWindows";
import { densityFor } from "../../../lib/phone-density";
import { AccountSettingsGroup } from "./AccountSettingsGroup";
import { WorkspaceRow } from "./WorkspaceRow";
import type { WorkspaceEntry } from "../../../lib/workspace-entries";
import { isCloudWorkspace, useCloudWorkspaces } from "../../../lib/workspace-route";
import { workspaceColor } from "../../../lib/workspace-color";
import { useCloudSession } from "../../../hooks/useCloudSession";
import { useActiveInstance } from "../../../contexts/active-instance";
import { getDomainHttpClient, useDomainHttpOptional } from "../../../contexts/domain";
import { isPhoneLayout } from "../../../lib/native-phone-layout";
import { isInvitationExpired } from "../../../lib/api";
import { usePendingInvitations } from "../../../lib/use-pending-invitations";

type PendingInvitations = ReturnType<typeof usePendingInvitations>;

export interface WorkspaceMenuSectionProps {
  /**
   * Every workspace the switcher lists, whatever hosts it: cloud workspaces and
   * a paired computer's own workspaces, in one list (SHO-108). Built once by
   * `buildWorkspaceEntries`, so this section never decides a host.
   */
  entries: WorkspaceEntry[];
  /** `WorkspaceEntry.key` of the workspace in view — the row that is checked. */
  currentKey: string | null;
  /** One switch path: the caller decides what opening an entry means. */
  onSelect: (entry: WorkspaceEntry) => void;
  /**
   * The cloud workspace behind the identity header, billing and settings. A
   * machine workspace has no billing account, so those stay the cloud
   * workspace's while its rows and the checkmark follow the machine.
   */
  currentWorkspace: any;
  billingData: any;
  workspacePlan: { planId: string; status: string | null } | null;
  allPlans: Record<string, { planId: string; status: string | null }>;
  showBilling: boolean;
  onNavigate: (href: string) => void;
  /**
   * Joining a workspace from a pending invitation. Not a switch path for the
   * list — that is `onSelect` — but accepting an invite is a cloud membership
   * action, so it names the workspace by id.
   */
  onSwitchWorkspace?: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  /**
   * Whether the current user already has a `kind: 'personal'` workspace.
   * `false` shows the free "Create personal space" CTA below the workspace
   * list — targets users whose original signup workspace was mis-backfilled
   * to `kind: 'team'` (see `POST /api/workspaces/personal`), who otherwise
   * have no way to get a personal/companion workspace. Omit (or leave
   * `undefined`) to hide the CTA, e.g. while the workspace list is loading.
   */
  hasPersonalWorkspace?: boolean;
  onCreatePersonalWorkspace?: () => void;
  localMode?: boolean;
  onClose: () => void;
  includePlan?: boolean;
  /** Native Account group rows (Profile, API Keys) rendered with Usage. */
  accountItems?: ReactNode;
  /** Native Settings rows (Workspace, People, …) between identity and Account. */
  settingsItems?: ReactNode;
  isNative?: boolean;
  /**
   * `full` is the account page and the legacy popover. `switcher` is the
   * rail tile's lean list. `workspace-menu` is the panel-header menu
   * (identity, settings, usage) without the workspace list.
   */
  presentation?: "full" | "switcher" | "workspace-menu";
}

/**
 * The per-row badge in the workspace switcher used to show the billing
 * plan (Free/Pro/Business). That's redundant with the workspace's own name
 * and settings, and doesn't help users tell workspaces apart. Show the
 * structural `kind` instead — "Personal" vs "Team" — which is what
 * actually determines the sidebar/shell chrome (`useWorkspaceExperience`).
 * On desktop, where local and cloud workspaces share the list, show where
 * the workspace lives instead: "Local" or "Cloud".
 */
export function workspaceKindBadge(
  ws: { kind?: string },
  opts: { localMode?: boolean; cloud?: boolean } = {},
): {
  highlighted: boolean;
  label: string;
} {
  if (opts.localMode) {
    return opts.cloud ? { highlighted: true, label: "Cloud" } : { highlighted: false, label: "Local" };
  }
  const isPersonal = ws.kind === "personal";
  return { highlighted: isPersonal, label: isPersonal ? "Personal" : "Team" };
}

/**
 * Workspace invitations this user could take up, shown above the workspace
 * list in the phone sheet and the wide sidebar. One component for both
 * surfaces: the switcher is the one place you go to change workspaces, so a
 * workspace you can join belongs there, not four taps deep in the settings of
 * a workspace you are already in. Project invitations stay in
 * `ProjectAccessPanel` — they do not add a row here.
 *
 * Presentational on purpose: the fetch lives in `WorkspaceMenuSection` so one
 * open of the switcher is one `GET /api/invitations`, no matter how many
 * branches of the section render the block.
 */
function PendingInvitationsSection({
  invitations,
  isNative,
  onSwitchWorkspace,
  onClose,
}: {
  invitations: PendingInvitations;
  isNative: boolean;
  onSwitchWorkspace?: (workspaceId: string) => void;
  onClose: () => void;
}) {
  const density = densityFor(isNative);
  const { pendingInvites, processingInvite, acceptInvite, declineInvite } = invitations;

  // No domain store above means Accept/Decline have nothing to join with, so
  // show no block at all rather than a dead one.
  if (pendingInvites.length === 0 || !invitations.canRespond) return null;

  return (
    <View className="border-b border-border pb-1">
      <Text
        className={cn(
          "px-4 py-1.5 font-semibold uppercase tracking-wider text-muted-foreground",
          density.text.label,
        )}
      >
        Pending invitations
      </Text>
      {pendingInvites.map((invite: any) => {
        const name = invite.workspace?.name || invite.workspaceName || "Workspace";
        const expired = isInvitationExpired(invite);
        const busy = processingInvite?.id === invite.id;
        const isAccepting = busy && processingInvite?.action === "accept";
        const isDeclining = busy && processingInvite?.action === "decline";
        return (
          <View key={invite.id} className="px-4 pb-2 pt-1">
            <View className="flex-row items-center gap-2">
              <Text className={cn("flex-1 font-medium text-foreground", density.text.body)} numberOfLines={1}>
                {name}
              </Text>
              {expired && (
                <View className="rounded bg-amber-100 px-1.5 py-0.5 dark:bg-amber-950/40">
                  <Text className={cn("text-amber-700 dark:text-amber-300", density.text.caption)}>
                    Expired
                  </Text>
                </View>
              )}
              {invite.role ? (
                <View className="rounded bg-muted px-1.5 py-0.5">
                  <Text className={cn("capitalize text-muted-foreground", density.text.caption)}>
                    {invite.role}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text className={cn("mt-0.5 text-muted-foreground", density.text.caption)}>
              {expired ? "Expired invitation. Ask for a new invite to join." : "Invited to join this workspace"}
            </Text>
            <View className="mt-2 flex-row gap-2">
              <Pressable
                disabled={expired || busy}
                onPress={async () => {
                  if (!(await acceptInvite(invite))) return;
                  onSwitchWorkspace?.(invite.workspaceId);
                  onClose();
                }}
                accessibilityLabel={`Accept invitation to ${name}`}
                className={cn(
                  "h-8 flex-1 items-center justify-center rounded-md",
                  expired ? "bg-muted" : "bg-primary",
                  (expired || busy) && "opacity-50",
                )}
              >
                {isAccepting ? (
                  <ActivityIndicator size="small" color="white" />
                ) : (
                  <Text
                    className={cn(
                      "text-xs font-medium",
                      expired ? "text-muted-foreground" : "text-primary-foreground",
                    )}
                  >
                    {expired ? "Expired" : "Accept"}
                  </Text>
                )}
              </Pressable>
              <Pressable
                disabled={busy}
                onPress={() => void declineInvite(invite)}
                accessibilityLabel={`Decline invitation to ${name}`}
                className={cn(
                  "h-8 flex-1 items-center justify-center rounded-md border border-border",
                  busy && "opacity-50",
                )}
              >
                {isDeclining ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <Text className="text-xs font-medium text-foreground">
                    {expired ? "Dismiss" : "Decline"}
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function WorkspaceMenuSection({
  entries,
  currentKey,
  onSelect,
  currentWorkspace,
  billingData,
  workspacePlan,
  allPlans,
  showBilling,
  onNavigate,
  onSwitchWorkspace,
  onCreateWorkspace,
  hasPersonalWorkspace,
  onCreatePersonalWorkspace,
  localMode,
  onClose,
  isNative = false,
  includePlan = true,
  accountItems,
  settingsItems,
  presentation = "full",
}: WorkspaceMenuSectionProps) {
  const posthog = usePostHogSafe();
  const density = densityFor(isNative);
  const cloud = useCloudWorkspaces();
  // One fetch per open: the block itself is presentational, so the three
  // branches below that render it share this single load.
  const invitations = usePendingInvitations({ enabled: presentation !== "workspace-menu" });
  const { width, height } = useWindowDimensions();
  // "Manage workspaces" is a signpost to wherever rename/delete live on this
  // surface. `/account` is the phone/native account page — on wide web it
  // redirects straight back to the shell (`usePhoneOnlyRoute`), so desktop goes
  // to the workspace settings page instead.
  const manageWorkspacesHref =
    isNative || Platform.OS !== "web" || isPhoneLayout(width, height)
      ? "/(app)/account"
      : "/(app)/settings?tab=workspace";
  const currentIsCloud = !!localMode && isCloudWorkspace(currentWorkspace?.id);

  // Switching workspaces deliberately leaves runtimes warm, so an agent can be
  // mid-turn in a workspace the user just left. Say so here instead of letting
  // that work look like it vanished (Decision 3).
  // The wide-web popover renders through a portal outside `SDKDomainProvider`,
  // so a context read gives nothing there. Fall back to the provider's own
  // singleton client (same instance, no context needed) — the badge has to work
  // on desktop, which is where it matters.
  const contextHttp = useDomainHttpOptional();
  const http = contextHttp ?? getDomainHttpClient();
  const [busyElsewhere, setBusyElsewhere] = useState(0);
  useEffect(() => {
    setBusyElsewhere(0);
    if (!localMode || !http) return;
    let cancelled = false;
    http
      .get<{ items?: Array<{ workspaceId: string; inFlight?: boolean }> }>("/api/workspaces/activity")
      .then((res) => {
        if (cancelled) return;
        const items = res.data?.items ?? [];
        setBusyElsewhere(
          items.filter((item) => item.inFlight && item.workspaceId !== currentWorkspace?.id).length,
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [http, localMode, currentWorkspace?.id]);

  // While one of a paired desktop's own workspaces is open, the identity header
  // names *that* workspace. Ids, billing and settings stay the cloud
  // workspace's — only the label follows what the user is looking at.
  const { instance: activeInstance } = useActiveInstance()
  const machineHost = activeInstance?.source === "machine" ? activeInstance : null
  const workspaceLabel =
    (machineHost ? machineHost.localWorkspaceName : undefined) ??
    currentWorkspace?.name
  const wsInitial = workspaceLabel?.[0]?.toUpperCase() ?? "W";
  const resolvedPlanId =
    (billingData.hasActiveSubscription && billingData.subscription?.planId) ||
    workspacePlan?.planId ||
    "free";
  const planType = getPlanDisplayName(
    resolvedPlanId !== "free" ? resolvedPlanId : undefined,
  );

  const openWorkspaceSettings = useCallback(() => {
    onNavigate("/(app)/settings");
    onClose();
  }, [onNavigate, onClose]);
  const openInvite = useCallback(() => {
    onClose();
    // Desktop has no invite flow of its own; cloud workspaces manage members
    // in the Shogo Cloud web app.
    if (currentIsCloud && cloud.cloudUrl) {
      const id = encodeURIComponent(currentWorkspace.id);
      void Linking.openURL(`${cloud.cloudUrl.replace(/\/+$/, "")}/settings?tab=people&workspace=${id}`);
      return;
    }
    onNavigate("/(app)/settings?tab=people");
  }, [onNavigate, onClose, currentIsCloud, cloud.cloudUrl, currentWorkspace?.id]);

  const identityHeader = currentWorkspace ? (
    <View className={cn("px-4", isNative ? "py-4" : "py-3")}>
      <View className="flex-row items-start gap-3">
        <View
          className={cn(
            "items-center justify-center",
            isNative ? `rounded-lg bg-primary/10 ${density.hitSize}` : "h-10 w-10 rounded-xl",
          )}
          style={isNative ? undefined : { backgroundColor: workspaceColor(currentWorkspace?.id) }}
        >
          <Text
            className={cn(
              isNative ? `font-medium text-primary ${density.text.body}` : "text-sm font-bold text-white",
            )}
          >
            {wsInitial}
          </Text>
        </View>
        <View className="flex-1 min-w-0">
          <Text
            className={cn(
              "font-medium text-foreground",
              density.text.title,
            )}
            numberOfLines={1}
          >
            {workspaceLabel}
          </Text>
          {machineHost ? (
            <View className="mt-0.5 flex-row items-center gap-1">
              <Text className={cn("text-muted-foreground", density.text.label)} numberOfLines={1}>
                {machineHost.localWorkspaceKind === "personal" ? "Personal" : "Team"}
                {" \u00B7 "}
                {machineHost.hostname ?? "your computer"}
              </Text>
            </View>
          ) : currentIsCloud ? (
            <View className="mt-0.5 flex-row items-center gap-1">
              {cloud.reachable ? (
                <Cloud size={12} className="text-muted-foreground" />
              ) : (
                <CloudOff size={12} className="text-destructive" />
              )}
              <Text
                className={cn(
                  cloud.reachable ? "text-muted-foreground" : "text-destructive",
                  density.text.label,
                )}
                numberOfLines={1}
              >
                {cloud.reachable
                  ? `Shogo Cloud${cloud.user?.email ? ` \u00B7 ${cloud.user.email}` : ""}`
                  : "Offline \u00B7 can't reach Shogo Cloud"}
              </Text>
            </View>
          ) : showBilling ? (
            <Text
              className={cn(
                "text-muted-foreground",
                density.text.label,
                "mt-0.5",
              )}
            >
              {planType} Plan {"\u00B7"} 1 member
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  ) : null;

  const identityPills = currentWorkspace ? (
    <View className="flex-row gap-2 px-3 pb-2">
      <Pressable
        onPress={openWorkspaceSettings}
        accessibilityLabel="Workspace settings"
        className="h-8 flex-1 flex-row items-center justify-center gap-1.5 rounded-md border border-border active:bg-muted"
      >
        <Settings size={14} className="text-muted-foreground" />
        <Text className="text-xs text-foreground">Settings</Text>
      </Pressable>
      {(!localMode || (currentIsCloud && currentWorkspace?.kind !== "personal")) && (
        <Pressable
          onPress={openInvite}
          accessibilityLabel={currentIsCloud ? "Manage in Shogo Cloud" : "Invite"}
          className="h-8 flex-1 flex-row items-center justify-center gap-1.5 rounded-md border border-border active:bg-muted"
        >
          <Users size={14} className="text-muted-foreground" />
          <Text className="text-xs text-foreground">
            {currentIsCloud ? "Manage in Shogo Cloud" : "Invite"}
          </Text>
          {currentIsCloud && <ExternalLink size={12} className="text-muted-foreground" />}
        </Pressable>
      )}
    </View>
  ) : null;

  const plan = includePlan && showBilling && currentWorkspace ? (
    <>
      {!isNative && <View className="h-px bg-border" />}
      <View className={cn("px-4 gap-2", isNative ? "py-3.5" : "py-3")}>
        <Text className={cn("text-muted-foreground", density.text.body)}>
          Usage
        </Text>
        <CompactUsageWindows
          windows={billingData.usageWindows}
          overage={
            billingData.effectiveBalance
              ? {
                  enabled: billingData.effectiveBalance.overageEnabled,
                  active: billingData.effectiveBalance.overageActive,
                  accumulatedUsd:
                    billingData.effectiveBalance.overageAccumulatedUsd,
                }
              : undefined
          }
          comfortable={isNative}
        />
      </View>
      {planType === "Free" && (
        <View className="px-3 py-2">
          <Pressable
            onPress={() => {
              trackEvent(posthog, EVENTS.UPGRADE_CLICKED);
              onNavigate("/(app)/billing");
              onClose();
            }}
            className={cn(
              "flex-row items-center justify-center gap-2 rounded-md",
              isNative ? "h-11" : "h-9",
            )}
            style={
              Platform.OS === "web"
                ? ({
                    backgroundImage:
                      "linear-gradient(to right, #3b82f6, #9333ea)",
                  } as any)
                : { backgroundColor: "#7c3aed" }
            }
          >
            <Zap
              size={isNative ? density.icon.md : 16}
              className="text-white"
            />
            <Text className={cn("font-medium text-white", density.text.body)}>
              Upgrade to Pro
            </Text>
          </Pressable>
        </View>
      )}
    </>
  ) : null;

  const pendingInvitations = (
    <PendingInvitationsSection
      invitations={invitations}
      isNative={isNative}
      onSwitchWorkspace={onSwitchWorkspace}
      onClose={onClose}
    />
  );

  /**
   * One list, one row — cloud workspaces and a paired computer's own
   * workspaces alike (SHO-108). The only per-entry difference a row draws is
   * the `Local` chip and the host subtitle, both of which come from the entry.
   */
  const entryRows = entries.map((entry) => {
    const hostedInCloud = !localMode || isCloudWorkspace(entry.id);
    return (
      <WorkspaceRow
        key={entry.key}
        entry={entry}
        isCurrent={entry.key === currentKey}
        onPress={(selected) => {
          onSelect(selected);
          onClose();
        }}
        localMode={!!localMode}
        cloudHosted={hostedInCloud}
        cloudUnreachable={hostedInCloud && !cloud.reachable}
        isNative={isNative}
      />
    );
  });

  const workspaceRows = (
    <>
      {entryRows}
      {!localMode && hasPersonalWorkspace === false && onCreatePersonalWorkspace && (
        <Pressable
          onPress={() => {
            onClose();
            onCreatePersonalWorkspace();
          }}
          className={cn(
            "flex-row items-center gap-2 px-4 active:bg-muted",
            isNative ? "py-3.5" : "py-2",
            !isNative && "rounded-md",
          )}
        >
          <Sparkles size={isNative ? 18 : 16} className="text-primary" />
          <Text className={cn("text-foreground flex-1", density.text.body)}>
            Create personal space
          </Text>
          <View className="rounded bg-primary/10 px-1.5 py-0.5">
            <Text
              className={cn(density.text.caption, "text-primary font-medium")}
            >
              Free
            </Text>
          </View>
        </Pressable>
      )}
      {localMode && (
        <CloudSessionRow isNative={isNative} />
      )}
      <Pressable
        onPress={() => {
          onClose();
          onCreateWorkspace();
        }}
        accessibilityLabel="Create new workspace"
        className={cn(
          "flex-row items-center gap-2 px-4 active:bg-muted",
          isNative ? "py-3.5" : "py-2",
          !isNative && "rounded-md",
        )}
      >
        <Plus size={isNative ? 18 : 16} className="text-muted-foreground" />
        <Text className={cn("text-foreground", density.text.body)}>
          Create new workspace
        </Text>
      </Pressable>
      {busyElsewhere > 0 && (
        <Text
          className={cn(density.text.caption, "px-4 pb-1 text-muted-foreground")}
          accessibilityLabel={`Working in ${busyElsewhere} other ${busyElsewhere === 1 ? "workspace" : "workspaces"}`}
        >
          Working in {busyElsewhere} other {busyElsewhere === 1 ? "workspace" : "workspaces"}
        </Text>
      )}
    </>
  );

  const switcherRows = (
    <View className="gap-0.5 px-2 py-2">
      {pendingInvitations}
      {entryRows}
      {!localMode && hasPersonalWorkspace === false && onCreatePersonalWorkspace && (
        <Pressable
          onPress={() => {
            onClose();
            onCreatePersonalWorkspace();
          }}
          accessibilityLabel="Create personal space"
          className="flex-row items-center gap-3 rounded-lg px-2 py-1.5 active:bg-muted"
        >
          <View className="h-11 w-11 items-center justify-center">
            <View className="h-9 w-9 items-center justify-center rounded-lg bg-muted">
              <Sparkles size={16} className="text-primary" />
            </View>
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
              Create personal space
            </Text>
            <Text className="text-xs text-muted-foreground">Free</Text>
          </View>
        </Pressable>
      )}
      {localMode && <CloudSessionRow isNative={false} />}
      <Pressable
        onPress={() => {
          onClose();
          onCreateWorkspace();
        }}
        accessibilityLabel="Create new workspace"
        className="flex-row items-center gap-3 rounded-lg px-2 py-1.5 active:bg-muted"
      >
        <View className="h-11 w-11 items-center justify-center">
          <View className="h-9 w-9 items-center justify-center rounded-lg bg-muted">
            <Plus size={18} className="text-foreground" />
          </View>
        </View>
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
          Create new workspace
        </Text>
      </Pressable>
      {/* Rename/delete live in Settings; this is only a signpost to them that
          works at every width and on native, so the switcher doesn't grow a
          second copy of the management UI. */}
      <Pressable
        onPress={() => {
          onClose();
          onNavigate(manageWorkspacesHref);
        }}
        accessibilityLabel="Manage workspaces"
        className="flex-row items-center gap-3 rounded-lg px-2 py-1.5 active:bg-muted"
      >
        <View className="h-11 w-11 items-center justify-center">
          <View className="h-9 w-9 items-center justify-center rounded-lg bg-muted">
            <Settings size={18} className="text-foreground" />
          </View>
        </View>
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
          Manage workspaces
        </Text>
      </Pressable>
      {busyElsewhere > 0 && (
        <Text
          className="px-2 pb-1 text-xs text-muted-foreground"
          accessibilityLabel={`Working in ${busyElsewhere} other ${busyElsewhere === 1 ? "workspace" : "workspaces"}`}
        >
          Working in {busyElsewhere} other {busyElsewhere === 1 ? "workspace" : "workspaces"}
        </Text>
      )}
    </View>
  );

  if (presentation === "switcher") return switcherRows;
  if (presentation === "workspace-menu") {
    return (
      <>
        {identityHeader}
        {identityPills}
        {plan}
      </>
    );
  }

  if (isNative) {
    return (
      <>
        {identityHeader ? (
          <AccountSettingsGroup className="mt-2">{identityHeader}</AccountSettingsGroup>
        ) : null}
        {settingsItems}
        {plan || accountItems ? (
          <AccountSettingsGroup title="Account">
            {accountItems}
            {plan}
          </AccountSettingsGroup>
        ) : null}
        <AccountSettingsGroup title="Workspaces">
          {pendingInvitations}
          {workspaceRows}
        </AccountSettingsGroup>
      </>
    );
  }

  return (
    <>
      {identityHeader}
      {identityPills}
      {plan}
      <View className="h-px bg-border" />
      {pendingInvitations}
      <View className="py-1">
        <Text
          className={cn(
            "px-4 py-1.5 font-semibold uppercase tracking-wider text-muted-foreground",
            density.text.label,
          )}
        >
          All workspaces
        </Text>
        {workspaceRows}
      </View>
    </>
  );
}

/** Desktop: sign in to Shogo Cloud, or show the account with Sign out. */
function CloudSessionRow({ isNative }: { isNative: boolean }) {
  const density = densityFor(isNative);
  const { cloud, pending, error, signIn, signOut } = useCloudSession();
  const rowClass = cn(
    "flex-row items-center gap-2 px-4",
    isNative ? "py-3.5" : "py-2",
    !isNative && "rounded-md",
  );
  const iconSize = isNative ? 18 : 16;

  const errorText = error ? (
    <Text className={cn("px-4 pb-2 text-destructive", density.text.caption)}>{error}</Text>
  ) : null;

  if (!cloud.signedIn) {
    return (
      <>
        <Pressable
          onPress={() => void signIn()}
          disabled={pending !== null}
          accessibilityLabel="Sign in to Shogo Cloud"
          className={cn(rowClass, "active:bg-muted", pending && "opacity-60")}
        >
          <LogIn size={iconSize} className="text-muted-foreground" />
          <Text className={cn("text-foreground flex-1", density.text.body)} numberOfLines={1}>
            {pending === "signin" ? "Waiting for browser\u2026" : "Sign in to Shogo Cloud"}
          </Text>
        </Pressable>
        {errorText}
      </>
    );
  }

  return (
    <>
      <View className={rowClass}>
        {cloud.reachable ? (
          <Cloud size={iconSize} className="text-muted-foreground" />
        ) : (
          <CloudOff size={iconSize} className="text-destructive" />
        )}
        <Text
          className={cn("flex-1", cloud.reachable ? "text-muted-foreground" : "text-destructive", density.text.label)}
          numberOfLines={1}
        >
          {cloud.reachable
            ? cloud.user?.email ?? "Shogo Cloud"
            : "Offline \u00B7 can't reach Shogo Cloud"}
        </Text>
        <Pressable
          onPress={() => void signOut()}
          disabled={pending !== null}
          accessibilityLabel="Sign out of Shogo Cloud"
          className={cn(
            "flex-row items-center gap-1 rounded-md px-2 py-1 active:bg-muted",
            pending && "opacity-60",
          )}
        >
          <LogOut size={14} className="text-muted-foreground" />
          <Text className={cn("text-foreground", density.text.caption)}>
            {pending === "signout" ? "Signing out\u2026" : "Sign out"}
          </Text>
        </Pressable>
      </View>
      {errorText}
    </>
  );
}
