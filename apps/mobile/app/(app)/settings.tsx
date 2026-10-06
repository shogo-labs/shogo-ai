// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings Page - Mobile (Expo)
 *
 * Lovable-style sidebar navigation (desktop) / horizontal tabs (mobile):
 * - Workspace: Name, avatar, danger zone
 * - People: Workspace members
 * - Account: Profile, email, preferences
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  View,
  ScrollView,
  Pressable,
  Modal,
  ActivityIndicator,
  Linking,
  Platform,
  useWindowDimensions,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { observer } from "mobx-react-lite";
import {
  ArrowLeft as ArrowLeftIcon,
  Building2 as Building2Icon,
  Users as UsersIcon,
  Boxes as BoxesIcon,
  Shield as ShieldIcon,
  User as UserIcon,
  ExternalLink as ExternalLinkIcon,
  Trash2 as Trash2Icon,
  ChevronDown as ChevronDownIcon,
  X as XGlyph,
  Search as SearchIcon,
  UserPlus as UserPlusIcon,
  Mail as MailIcon,
  BarChart3 as BarChart3Icon,
  MessageSquare as MessageSquareIcon,
  Zap as ZapIcon,
  CreditCard as CreditCardIcon,
  Cloud as CloudIcon,
  Server as ServerIcon,
  Coins as CoinsIcon,
  Plug as PlugIcon,
  Download as DownloadIcon,
  Monitor as MonitorIcon,
  Laptop as LaptopIcon,
  Paintbrush as PaintbrushIcon,
  RefreshCw as RefreshCwIcon,
  KeyRound as KeyRoundIcon,
  LogOut as LogOutIcon,
  Plus as PlusIcon,
  Sparkles as SparklesIcon,
} from "lucide-react-native";
import {
  Text,
  useAccountSheetIcons,
} from "../../components/settings/account-sheet-chrome";
import { AppearanceTab } from "../../components/settings/AppearanceTab";
import { CreateWorkspaceModal } from "../../components/layout/sidebar/CreateWorkspaceModal";
import { useAuth } from "../../contexts/auth";
import {
  useDomain,
  useWorkspaceCollection,
  useProjectCollection,
  useMemberCollection,
  useDomainHttp,
  type IDomainStore,
} from "../../contexts/domain";
import { useDomainActions } from "@shogo/shared-app/domain";
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { usePooledWorkspaceCreation } from "../../hooks/usePooledWorkspaceCreation";
import {
  resolveActiveWorkspaceId,
  setActiveWorkspaceId,
} from "../../lib/workspace-store";
import {
  api,
  API_URL,
  type WorkspaceChildrenResponse,
} from "../../lib/api";
import { useBillingData } from "@shogo/shared-app/hooks";
import {
  formatUsd,
  getWindowDisplays,
  getUsageLimitNotice,
} from "../../lib/billing-config";
import { usePlatformConfig } from "../../lib/platform-config";
import { openWebAppSession } from "../../lib/openWebAppSession";
import { usePostHogSafe } from "../../contexts/posthog";
import { EVENTS, trackEvent } from "../../lib/analytics";
import { useCloudBillingSummary } from "../../hooks/useCloudBillingSummary";
import { SecuritySettingsPanel } from "../../components/security/SecuritySettingsPanel";
import { ComputerAndFilesPanel } from "../../components/settings/ComputerAndFilesPanel";
import { ComputeTab } from "../../components/settings/ComputeTab";
import { LocalCloudBillingTab } from "../../components/settings/LocalCloudBillingTab";
import { UpdatesTab } from "../../components/settings/UpdatesTab";
import { IntegrationsTab } from "../../components/settings/IntegrationsTab";
import { AutomationsTab } from "../../components/settings/AutomationsTab";
import { WorkspaceModelsTab } from "../../components/settings/WorkspaceModelsTab";
import { RemoteControlTab } from "../../components/settings/RemoteControlTab";
import {
  type AnalyticsPeriod,
  type UsageSummaryData,
  type UsageLogData,
  type ChatAnalyticsData,
  type UsageBreakdownData,
  type SpendGroupBy,
  type SpendMetric,
  PeriodSelector,
  StatCard,
  UsageTableSection,
  ChatAnalyticsSection,
  UsageBreakdownSection,
  UsageTimeseriesChart,
} from "../../components/analytics/SharedAnalytics";
import { DateRangePills } from "../../components/analytics/DateRangePills";
import { UsageLeaderboard } from "../../components/analytics/UsageLeaderboard";
import { BillingProgressCard } from "../../components/billing/BillingProgressCard";
import { SetSpendLimitDialog } from "../../components/billing/SetSpendLimitDialog";
import { CostAnalyticsTab } from "../../components/analytics/CostAnalyticsTab";
import { PeopleTab } from "../../components/settings/people/PeopleTab";
import { LeaveWorkspaceDialog } from "../../components/settings/people/LeaveWorkspaceDialog";
import { canLeave } from "../../components/settings/people/member-permissions";
import { WorkspaceActivitySection } from "../../components/analytics/WorkspaceActivitySection";
import { useVisibleModels } from "../../lib/visible-models";
import {
  isNativePhoneIntegrationsLayout,
  WEB_WIDE_MIN_WIDTH,
} from "../../lib/native-phone-layout";
import { CHANGELOG_URL, DOCS_URL } from "../../lib/theme-choices";
import whatsNewCatalog from "../../lib/whats-new/releases.generated.json";
import {
  reloadAfterWorkspaceSwitch,
  scheduleWorkspaceSwitch,
} from "../../lib/switch-workspace";

import {
  SETTINGS_TABS,
  settingsNavItems,
  settingsTab,
  type SettingsTabId,
} from "../../lib/settings-tabs";
import { leaveSettings } from "../../lib/settings-back";
import {
  useToast,
  Toast,
  ToastTitle,
  ToastDescription,
} from "@/components/ui/toast";
import {
  Card,
  CardContent,
  Button,
  Input,
  Badge,
  Separator,
  Switch,
  cn,
} from "@shogo/shared-ui/primitives";
import { useNotifyOnTurnComplete as useNotifyOnTurnCompletePref } from "../../lib/notifications/preferences";
import { useRequireBiometricApproval } from "../../lib/approval-lock";
import { useDualPlan } from "../../lib/dual-plan-preference";

const latestAnnouncedRelease = whatsNewCatalog.find((release) => release.announce);

const SETTINGS_ICON_MAP = {
  ArrowLeft: ArrowLeftIcon,
  Building2: Building2Icon,
  Users: UsersIcon,
  Boxes: BoxesIcon,
  Shield: ShieldIcon,
  User: UserIcon,
  ExternalLink: ExternalLinkIcon,
  Trash2: Trash2Icon,
  ChevronDown: ChevronDownIcon,
  X: XGlyph,
  Search: SearchIcon,
  UserPlus: UserPlusIcon,
  Mail: MailIcon,
  BarChart3: BarChart3Icon,
  MessageSquare: MessageSquareIcon,
  Zap: ZapIcon,
  CreditCard: CreditCardIcon,
  Cloud: CloudIcon,
  Server: ServerIcon,
  Coins: CoinsIcon,
  Plug: PlugIcon,
  Download: DownloadIcon,
  Monitor: MonitorIcon,
  Laptop: LaptopIcon,
  Paintbrush: PaintbrushIcon,
  RefreshCw: RefreshCwIcon,
} as const;

function useSettingsIcons() {
  return useAccountSheetIcons(SETTINGS_ICON_MAP);
}

const SETTINGS_TAB_ICON_NAME: Record<TabId, keyof typeof SETTINGS_ICON_MAP> = {
  workspace: "Building2",
  people: "Users",
  models: "Boxes",
  integrations: "Plug",
  automations: "Zap",
  "remote-control": "Monitor",
  account: "User",
  security: "Shield",
  "computer-files": "Laptop",
  billing: "CreditCard",
  compute: "Server",
  analytics: "BarChart3",
  costs: "Coins",
  appearance: "Paintbrush",
  updates: "RefreshCw",
};

export type TabId = SettingsTabId;

const ALL_TAB_IDS: TabId[] = SETTINGS_TABS.map(({ id }) => id);

/** Tablet/desktop split: matches `SettingsPage` `isWide` (sidebar layout). */
const SETTINGS_WIDE_BREAKPOINT = WEB_WIDE_MIN_WIDTH;
const HIDE_COMPUTE_PURCHASES_ON_IOS = Platform.OS === "ios";

// Whether we're running inside the Electron desktop shell. Deliberately NOT
// the same as the `localMode` passed into TabBar/SettingsSidebar below:
// `localMode` reflects the connected API's app-mode (self-hosted vs Shogo
// Cloud), while a cloud-connected desktop install still needs the Updates
// tab since it's the Electron auto-updater's home regardless of which
// backend the app talks to. See `desktopOnly` in lib/settings-tabs.ts.
const IS_DESKTOP_CLIENT =
  Platform.OS === "web" &&
  typeof window !== "undefined" &&
  !!(window as any).shogoDesktop?.isDesktop;

interface NavItem {
  id: TabId;
  label: string;
  icon: React.ElementType;
}

const MOBILE_NAV_ITEMS: NavItem[] = settingsNavItems([
  "workspace",
  "people",
  "models",
  "integrations",
  "automations",
  "remote-control",
  "account",
  "appearance",
  ...(!HIDE_COMPUTE_PURCHASES_ON_IOS ? ["compute" as TabId] : []),
  "billing",
  "analytics",
  "costs",
  ...(IS_DESKTOP_CLIENT ? ["updates" as TabId] : []),
]);

const LOCAL_NAV_ITEMS: NavItem[] = settingsNavItems([
  "workspace",
  "integrations",
  "automations",
  "remote-control",
  "account",
  "appearance",
  "security",
  ...(IS_DESKTOP_CLIENT ? ["computer-files" as TabId] : []),
  "billing",
  "analytics",
  "costs",
  ...(IS_DESKTOP_CLIENT ? ["updates" as TabId] : []),
]);

function TabBar({
  activeTab,
  onTabChange,
  showBilling = true,
  localMode = false,
}: {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  showBilling?: boolean;
  localMode?: boolean;
}) {
  const icons = useSettingsIcons();
  const items = showBilling && !localMode ? MOBILE_NAV_ITEMS : LOCAL_NAV_ITEMS;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="border-b border-border/70 bg-card"
      contentContainerClassName="gap-1 px-4 py-1"
      style={{ flexGrow: 0 }}
    >
      {items.map((item) => {
        const Icon = icons[SETTINGS_TAB_ICON_NAME[item.id]];
        const isActive = activeTab === item.id;
        return (
          <Pressable
            key={item.id}
            onPress={() => onTabChange(item.id)}
            className={cn(
              "flex-row items-center gap-2 rounded-lg px-3 py-2.5",
              isActive ? "bg-primary/10" : "active:bg-muted"
            )}
          >
            <Icon
              size={16}
              className={isActive ? "text-primary" : "text-muted-foreground"}
            />
            <Text
              className={cn(
                "text-sm font-medium",
                isActive ? "text-primary" : "text-muted-foreground"
              )}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

interface SidebarItem {
  id: TabId;
  label: string;
  avatar?: string;
}

interface SidebarSection {
  id: string;
  label?: string;
  items: SidebarItem[];
}

function SettingsSidebar({
  activeTab,
  onTabChange,
  workspaceName,
  userName,
  onExit,
  showBilling = true,
  localMode = false,
}: {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  workspaceName: string;
  userName: string;
  onExit: () => void;
  showBilling?: boolean;
  localMode?: boolean;
}) {
  const { ArrowLeft } = useSettingsIcons();
  const tabItem = (id: TabId): SidebarItem => ({
    id,
    label: settingsTab(id).label,
  });

  const workspaceItems: SidebarItem[] = [
    ...(!(localMode || !showBilling)
      ? [tabItem("people"), tabItem("models")]
      : []),
    tabItem("integrations"),
    tabItem("automations"),
    tabItem("remote-control"),
    ...(showBilling
      ? [
          ...(!HIDE_COMPUTE_PURCHASES_ON_IOS ? [tabItem("compute")] : []),
          tabItem("billing"),
          tabItem("analytics"),
          tabItem("costs"),
        ]
      : [tabItem("billing"), tabItem("analytics"), tabItem("costs")]),
  ];

  const sections: SidebarSection[] = [
    {
      id: "workspace",
      items: workspaceItems,
    },
    {
      id: "account",
      label: settingsTab("account").label,
      items: [
        {
          ...tabItem("account"),
          label: userName || settingsTab("account").label,
        },
        tabItem("appearance"),
        ...(!showBilling ? [tabItem("security")] : []),
        ...(!showBilling && IS_DESKTOP_CLIENT ? [tabItem("computer-files")] : []),
        ...(IS_DESKTOP_CLIENT ? [tabItem("updates")] : []),
      ],
    },
  ];

  return (
    <ScrollView
      className="w-[232px]"
      contentContainerClassName="px-3 pb-5 pt-5"
      showsVerticalScrollIndicator={false}
    >
      <Pressable
        onPress={onExit}
        className="mb-5 flex-row items-center gap-1.5 self-start rounded-lg px-2 py-1.5 active:bg-muted"
      >
        <ArrowLeft size={14} className="text-muted-foreground" />
        <Text className="text-sm text-muted-foreground">Go back</Text>
      </Pressable>
      <WorkspaceAccountActions
        onSelectTab={onTabChange}
        showActions={false}
        showSignOut={false}
        variant="sidebar"
      />

      {sections.map((section, sectionIdx) => (
        <View key={section.id} className={sectionIdx > 0 ? "mt-6" : ""}>
          {section.label && (
            <Text className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {section.label}
            </Text>
          )}
          <View className="gap-0.5">
            {section.items.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <Pressable
                  key={item.id}
                  onPress={() => onTabChange(item.id)}
                  className={cn(
                    "flex-row items-center gap-2 rounded-lg px-2.5 py-2.5",
                    isActive
                      ? "border border-primary/20 bg-primary/5"
                      : "active:bg-muted"
                  )}
                >
                  {item.avatar && (
                    <View className="h-5 w-5 rounded bg-primary items-center justify-center">
                      <Text className="text-[10px] font-semibold text-primary-foreground">
                        {item.avatar}
                      </Text>
                    </View>
                  )}
                  <Text
                    className={cn(
                      "text-sm flex-1",
                      isActive
                        ? "text-foreground font-medium"
                        : "text-muted-foreground"
                    )}
                    numberOfLines={1}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
      <WorkspaceAccountActions
        onSelectTab={onTabChange}
        showWorkspace={false}
        variant="sidebar"
      />
    </ScrollView>
  );
}

// ============================================================================
// WORKSPACE SETTINGS TAB
// ============================================================================

const WorkspaceSettingsTab = observer(function WorkspaceSettingsTab() {
  const { X } = useSettingsIcons();
  const { width } = useWindowDimensions();
  const isWideNameSection = width >= SETTINGS_WIDE_BREAKPOINT;
  const router = useRouter();
  const store = useDomain() as IDomainStore;
  const actions = useDomainActions();
  const { user } = useAuth();
  const { features: wsFeatures, localMode } = usePlatformConfig();
  const workspaces = useWorkspaceCollection();
  const members = useMemberCollection();
  const http = useDomainHttp();
  const currentWorkspace = useActiveWorkspace();

  const [name, setName] = useState(currentWorkspace?.name || "");
  const [trainingDataEnabled, setTrainingDataEnabled] = useState(
    currentWorkspace?.trainingDataMode !== "disabled"
  );
  const [trainingDataSaveStatus, setTrainingDataSaveStatus] = useState<
    "idle" | "saved" | "error"
  >("idle");
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">(
    "idle"
  );
  const [isLeaveDialogOpen, setIsLeaveDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const originalName = currentWorkspace?.name || "";
  const hasChanges = name !== originalName;
  const isValid = name.trim().length > 0 && name.length <= 60;

  const currentUserId = user?.id;
  const membersAll = Array.isArray(members.all) ? members.all : [];
  const workspaceMembers = currentWorkspace?.id
    ? membersAll.filter(
        (m: any) => m.workspaceId === currentWorkspace.id && !m.projectId
      )
    : [];
  const currentUserMember = workspaceMembers.find(
    (m: any) => m.userId === currentUserId
  );
  const isOwner = currentUserMember?.role === "owner";
  const canManageWorkspace = isOwner || currentUserMember?.role === "admin";

  // `kind` (not a slug/name heuristic) is the source of truth — a team
  // workspace named e.g. "My Personal Brand" must stay deletable.
  const isPersonalWorkspace = currentWorkspace?.kind === "personal";

  const wsAll = Array.isArray(workspaces.all) ? workspaces.all : [];
  const leavePermission = canLeave({
    viewerRole: currentUserMember?.role,
    workspaceCount: wsAll.length,
    otherOwnerCount: workspaceMembers.filter(
      (m: any) => m.role === "owner" && m.userId !== user?.id
    ).length,
  });
  const canDelete = isOwner && wsAll.length > 1 && !isPersonalWorkspace;
  const deleteConfirmRequired = currentWorkspace?.name || "delete";
  const isDeleteConfirmed = deleteConfirmText === deleteConfirmRequired;

  useEffect(() => {
    setName(currentWorkspace?.name || "");
    setSaveStatus("idle");
    setTrainingDataEnabled(currentWorkspace?.trainingDataMode !== "disabled");
    setTrainingDataSaveStatus("idle");
  }, [currentWorkspace?.name, currentWorkspace?.trainingDataMode]);

  useEffect(() => {
    if (currentWorkspace?.id) {
      members
        .loadAll({ workspaceId: currentWorkspace.id })
        .catch((e) => console.error("[Settings] Failed to load members:", e));
    }
  }, [currentWorkspace?.id]);

  const handleSave = async () => {
    if (!hasChanges || !isValid || !currentWorkspace?.id) return;
    setIsSaving(true);
    setSaveStatus("idle");
    try {
      await actions.updateWorkspace(currentWorkspace.id, { name: name.trim() });
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (error) {
      console.error("Failed to save workspace name:", error);
      setSaveStatus("error");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteWorkspace = async () => {
    if (!currentWorkspace?.id || !isDeleteConfirmed) return;
    setIsDeleting(true);
    try {
      await actions.deleteWorkspace(currentWorkspace.id);
      setIsDeleteDialogOpen(false);
      router.replace("/(app)");
    } catch (error) {
      console.error("Failed to delete workspace:", error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleTrainingDataChange = async (enabled: boolean) => {
    if (!currentWorkspace?.id || !canManageWorkspace) return;
    const previous = trainingDataEnabled;
    setTrainingDataEnabled(enabled);
    setTrainingDataSaveStatus("idle");
    try {
      await actions.updateWorkspace(currentWorkspace.id, {
        trainingDataMode: enabled ? "enabled" : "disabled",
      });
      setTrainingDataSaveStatus("saved");
      setTimeout(() => setTrainingDataSaveStatus("idle"), 2000);
    } catch (error) {
      console.error("Failed to update training data setting:", error);
      setTrainingDataEnabled(previous);
      setTrainingDataSaveStatus("error");
    }
  };

  return (
    <View className="gap-8">
      <View>
        <Text className="text-xl font-semibold text-foreground">
          Workspace settings
        </Text>
        <Text className="text-sm text-muted-foreground mt-1">
          Workspaces allow you to collaborate on projects in real time.
        </Text>
      </View>

      <Card>
        <CardContent className="p-0">
          {/* Name — stacked on narrow viewports; side-by-side on tablet/desktop */}
          {isWideNameSection ? (
            <View className="px-6 py-5 flex-row items-start justify-between">
              <View className="flex-[0.45] mr-4 pt-1">
                <Text className="text-base font-semibold text-foreground">
                  Name
                </Text>
                <Text className="text-sm text-muted-foreground mt-0.5">
                  Your full workspace name, as visible to others.
                </Text>
              </View>
              <View className="flex-[0.55]">
                <View className="flex-row gap-2 items-start">
                  <View className="flex-1">
                    <Input
                      value={name}
                      onChangeText={(t) => {
                        setName(t);
                        setSaveStatus("idle");
                      }}
                    />
                  </View>
                  <Button
                    onPress={handleSave}
                    disabled={!hasChanges || !isValid || isSaving}
                    size="sm"
                  >
                    {isSaving ? "Saving..." : "Save"}
                  </Button>
                </View>
                <Text className="text-xs text-muted-foreground mt-1.5 text-right">
                  {name.length} / 60 characters
                </Text>
                {saveStatus === "saved" && (
                  <Text className="text-xs text-green-600 mt-1">
                    Changes saved successfully!
                  </Text>
                )}
                {saveStatus === "error" && (
                  <Text className="text-xs text-destructive mt-1">
                    Failed to save changes. Please try again.
                  </Text>
                )}
              </View>
            </View>
          ) : (
            <View className="px-6 py-5">
              <Text className="text-base font-semibold text-foreground">
                Name
              </Text>
              <Text className="text-sm text-muted-foreground mt-0.5">
                Your full workspace name, as visible to others.
              </Text>
              <Input
                className="mt-3 w-full min-w-0"
                value={name}
                onChangeText={(t) => {
                  setName(t);
                  setSaveStatus("idle");
                }}
              />
              <Text className="text-xs text-muted-foreground mt-1.5">
                {name.length} / 60 characters
              </Text>
              <View className="mt-3 flex-row justify-end">
                <Button
                  onPress={handleSave}
                  disabled={!hasChanges || !isValid || isSaving}
                  size="sm"
                >
                  {isSaving ? "Saving..." : "Save"}
                </Button>
              </View>
              {saveStatus === "saved" && (
                <Text className="text-xs text-green-600 mt-2">
                  Changes saved successfully!
                </Text>
              )}
              {saveStatus === "error" && (
                <Text className="text-xs text-destructive mt-2">
                  Failed to save changes. Please try again.
                </Text>
              )}
            </View>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <View className="px-6 py-5 flex-row items-center justify-between">
            <View className="flex-1 mr-4">
              <Text className="text-base font-semibold text-foreground">
                Help improve Shogo models
              </Text>
              <Text className="text-sm text-muted-foreground mt-0.5">
                When enabled, prompts and responses sent through Shogo&apos;s AI
                service are stored for up to 3 years and used for analysis and
                to train Shogo&apos;s models. Turn this off to stop collection
                for this workspace.
              </Text>
              {trainingDataSaveStatus === "saved" && (
                <Text className="text-xs text-green-600 mt-1">
                  Changes saved successfully!
                </Text>
              )}
              {trainingDataSaveStatus === "error" && (
                <Text className="text-xs text-destructive mt-1">
                  Failed to save changes. Please try again.
                </Text>
              )}
            </View>
            <Switch
              value={trainingDataEnabled}
              onValueChange={handleTrainingDataChange}
              disabled={!canManageWorkspace}
            />
          </View>
        </CardContent>
      </Card>

      {!localMode && (
        <>
          {/* Leave workspace */}
          <Card>
            <CardContent className="p-0">
              <View className="px-6 py-5 flex-row items-center justify-between">
                <View className="flex-1 mr-4">
                  <Text className="text-base font-semibold text-foreground">
                    Leave workspace
                  </Text>
                  <Text className="text-sm text-muted-foreground mt-0.5">
                    Leave this workspace. You will lose access to its projects
                    and data.
                  </Text>
                  {!leavePermission.allowed && leavePermission.reason ? (
                    <Text className="text-xs text-muted-foreground mt-1">
                      {leavePermission.reason}
                    </Text>
                  ) : null}
                </View>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!leavePermission.allowed}
                  onPress={() => setIsLeaveDialogOpen(true)}
                >
                  Leave workspace
                </Button>
              </View>

              {isOwner && (
                <>
                  <Separator />
                  <View className="px-6 py-5 flex-row items-center justify-between">
                    <View className="flex-1 mr-4">
                      <Text className="text-base font-semibold text-destructive">
                        Delete workspace
                      </Text>
                      <Text className="text-sm text-muted-foreground mt-0.5">
                        {canDelete
                          ? "Permanently delete this workspace and all its data."
                          : isPersonalWorkspace
                          ? "Your personal workspace cannot be deleted."
                          : "You cannot delete your only workspace."}
                      </Text>
                    </View>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={!canDelete}
                      onPress={() => setIsDeleteDialogOpen(true)}
                    >
                      Delete
                    </Button>
                  </View>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* Leave Workspace Confirmation */}
      <LeaveWorkspaceDialog
        visible={isLeaveDialogOpen}
        workspaceId={currentWorkspace?.id}
        workspaceName={currentWorkspace?.name}
        onClose={() => setIsLeaveDialogOpen(false)}
      />

      {/* Delete Workspace Confirmation Modal */}
      <Modal
        visible={isDeleteDialogOpen}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setIsDeleteDialogOpen(false);
          setDeleteConfirmText("");
        }}
      >
        <Pressable
          className="flex-1 bg-black/50 justify-center items-center px-6"
          onPress={() => {
            setIsDeleteDialogOpen(false);
            setDeleteConfirmText("");
          }}
        >
          <Pressable className="bg-background rounded-xl p-6 w-full max-w-sm gap-4">
            <View className="flex-row items-center justify-between">
              <Text className="text-lg font-semibold text-destructive">
                Delete workspace
              </Text>
              <Pressable
                onPress={() => {
                  setIsDeleteDialogOpen(false);
                  setDeleteConfirmText("");
                }}
                className="p-1"
              >
                <X size={20} className="text-muted-foreground" />
              </Pressable>
            </View>
            <Text className="text-sm text-muted-foreground">
              This action cannot be undone. This will permanently delete the
              workspace "{currentWorkspace?.name}".
            </Text>
            <Text className="text-sm text-muted-foreground">
              Please type "{deleteConfirmRequired}" to confirm.
            </Text>
            <Input
              value={deleteConfirmText}
              onChangeText={setDeleteConfirmText}
              placeholder={`Type "${deleteConfirmRequired}" to confirm`}
            />
            <View className="flex-row gap-2 justify-end">
              <Button
                variant="outline"
                size="sm"
                onPress={() => {
                  setIsDeleteDialogOpen(false);
                  setDeleteConfirmText("");
                }}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onPress={handleDeleteWorkspace}
                disabled={!isDeleteConfirmed || isDeleting}
              >
                {isDeleting ? "Deleting..." : "Delete workspace"}
              </Button>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
});

// ============================================================================
// ACCOUNT TAB
// ============================================================================

function NotificationsCard() {
  const [notifyOnTurn, setNotifyOnTurn] = useNotifyOnTurnCompletePref();
  const [requireBiometric, setRequireBiometric] = useRequireBiometricApproval();
  return (
    <Card>
      <CardContent className="p-0">
        <View className="px-6 py-5 flex-row items-center justify-between">
          <View className="flex-1 mr-4">
            <Text className="text-sm font-semibold text-foreground">
              Notify when a reply is ready
            </Text>
            <Text className="text-sm text-muted-foreground mt-0.5">
              Send a system notification when a chat turn finishes while Shogo
              isn't in the foreground. Applies on desktop, web, and mobile.
            </Text>
          </View>
          <Switch
            checked={notifyOnTurn}
            onCheckedChange={(v) => {
              void setNotifyOnTurn(v);
            }}
          />
        </View>
        {Platform.OS !== "web" ? (
          <View className="px-6 py-5 flex-row items-center justify-between border-t border-border">
            <View className="flex-1 mr-4">
              <Text className="text-sm font-semibold text-foreground">
                Confirm approvals with Face ID or fingerprint
              </Text>
              <Text className="text-sm text-muted-foreground mt-0.5">
                Ask for Face ID or your fingerprint before an agent's action is
                approved from this device. Denying never asks.
              </Text>
            </View>
            <Switch
              checked={requireBiometric}
              onCheckedChange={(v) => setRequireBiometric(v)}
            />
          </View>
        ) : null}
      </CardContent>
    </Card>
  );
}

function DualPlanCard() {
  const [dualPlan, setDualPlan] = useDualPlan();
  return (
    <Card>
      <CardContent className="p-0">
        <View className="px-6 py-5 flex-row items-center justify-between">
          <View className="flex-1 mr-4">
            <Text className="text-sm font-semibold text-foreground">
              Generate summaries for plans
            </Text>
            <Text className="text-sm text-muted-foreground mt-0.5">
              When on, every plan you generate also gets a stakeholder summary
              alongside the technical body. You can flip between the Technical
              and Summary views from any plan, and generate summaries on demand
              for older plans.
            </Text>
          </View>
          <Switch
            checked={dualPlan}
            onCheckedChange={(v) => {
              void setDualPlan(v);
            }}
          />
        </View>
      </CardContent>
    </Card>
  );
}

function AccountTab() {
  const { user, signOut, updateUser } = useAuth();
  const http = useDomainHttp();
  const router = useRouter();
  const { localMode } = usePlatformConfig();
  const toast = useToast();

  const [name, setName] = useState(user?.name || "");
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">(
    "idle"
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const originalName = user?.name || "";
  const hasNameChanges = name !== originalName;
  const hasChanges = hasNameChanges;

  useEffect(() => {
    setName(user?.name || "");
  }, [user?.name]);

  const handleSave = async () => {
    if (!hasChanges || isSaving || !user?.id) return;
    if (hasNameChanges && !name.trim()) return;
    setIsSaving(true);
    setSaveStatus("idle");
    try {
      await updateUser({ name: name.trim() });
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (error) {
      console.error("Failed to save account settings:", error);
      setSaveStatus("error");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    router.replace(localMode ? "/" : "/(auth)/sign-in");
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== "DELETE" || !user?.id || !http) return;
    setIsDeleting(true);
    try {
      await api.deleteAccount(http, user.id);
      await signOut();
      router.replace(localMode ? "/" : "/(auth)/sign-in");
    } catch (error: any) {
      console.error("Failed to delete account:", error);
      const msg =
        error?.details?.error?.message ||
        error?.message ||
        "Failed to delete account. Please try again or contact support.";
      toast.show({
        placement: "top",
        duration: 5000,
        render: ({ id }: { id: string }) => (
          <Toast nativeID={id} variant="outline" action="error">
            <ToastTitle>Failed to delete account</ToastTitle>
            <ToastDescription>{msg}</ToastDescription>
          </Toast>
        ),
      });
    } finally {
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
      setDeleteConfirmText("");
    }
  };

  return (
    <View className="gap-8">
      <View>
        <Text className="text-xl font-semibold text-foreground">
          Account settings
        </Text>
        <Text className="text-sm text-muted-foreground mt-1">
          Personalize how others see and interact with you on Shogo.
        </Text>
      </View>

      {/* Profile */}
      <Card>
        <CardContent className="p-0">
          {/* Avatar */}
          <View className="px-6 py-5 flex-row items-center justify-between">
            <View className="flex-1 mr-4">
              <Text className="text-sm font-semibold text-foreground">
                Avatar
              </Text>
              <Text className="text-sm text-muted-foreground mt-0.5">
                Your avatar is fetched from your identity provider or
                automatically generated.
              </Text>
            </View>
            <View className="h-10 w-10 rounded-full bg-primary items-center justify-center">
              <Text className="text-sm font-semibold text-primary-foreground">
                {user?.name?.[0]?.toUpperCase() || "U"}
              </Text>
            </View>
          </View>

          <Separator />

          {/* Username */}
          <View className="px-6 py-5">
            <Text className="text-sm font-semibold text-foreground">
              Username
            </Text>
            <Text className="text-sm text-muted-foreground mt-0.5">
              Your public display name and profile identifier.
            </Text>
            <View className="flex-row gap-3 items-start mt-3">
              <View className="flex-1">
                <Input
                  value={name}
                  onChangeText={(t) => {
                    setName(t);
                    setSaveStatus("idle");
                  }}
                  placeholder="Enter a username"
                />
              </View>
              <Button
                variant="outline"
                size="sm"
                onPress={handleSave}
                disabled={!hasNameChanges || !name.trim() || isSaving}
              >
                {isSaving ? "Saving..." : "Update"}
              </Button>
            </View>
            {saveStatus === "saved" && (
              <Text className="text-xs text-green-600 mt-1">
                Updated successfully!
              </Text>
            )}
            {saveStatus === "error" && (
              <Text className="text-xs text-destructive mt-1">
                Failed to update. Please try again.
              </Text>
            )}
          </View>

          <Separator />

          {/* Email */}
          <View className="px-6 py-5">
            <Text className="text-sm font-semibold text-foreground">Email</Text>
            <Text className="text-sm text-muted-foreground mt-0.5">
              Your email address associated with your account.
            </Text>
            <Input className="mt-3" value={user?.email || ""} disabled />
          </View>
        </CardContent>
      </Card>

      <NotificationsCard />

      <DualPlanCard />

      {!localMode && (
        <Card>
          <CardContent className="p-0">
            {/* Delete account */}
            <View className="px-6 py-5">
              <View className="flex-row items-center justify-between">
                <View className="flex-1 mr-4">
                  <Text className="text-sm font-semibold text-foreground">
                    Delete account
                  </Text>
                  <Text className="text-sm text-muted-foreground mt-0.5">
                    Permanently delete your Shogo account. This cannot be
                    undone.
                  </Text>
                </View>
                <Button
                  variant="destructive"
                  size="sm"
                  onPress={() => setIsDeleteDialogOpen(true)}
                >
                  Delete
                </Button>
              </View>
              {isDeleteDialogOpen && (
                <View className="mt-4 p-4 border border-destructive/30 rounded-lg bg-destructive/5">
                  <Text className="text-sm text-foreground font-medium">
                    Are you sure? This action is irreversible.
                  </Text>
                  <Text className="text-sm text-muted-foreground mt-1">
                    Type "DELETE" to confirm.
                  </Text>
                  <Input
                    className="mt-2"
                    value={deleteConfirmText}
                    onChangeText={setDeleteConfirmText}
                    placeholder='Type "DELETE"'
                  />
                  <View className="flex-row gap-2 mt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onPress={() => {
                        setIsDeleteDialogOpen(false);
                        setDeleteConfirmText("");
                      }}
                      disabled={isDeleting}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onPress={handleDeleteAccount}
                      disabled={deleteConfirmText !== "DELETE" || isDeleting}
                    >
                      {isDeleting ? "Deleting..." : "Permanently delete"}
                    </Button>
                  </View>
                </View>
              )}
            </View>
          </CardContent>
        </Card>
      )}

      {/* Sign Out */}
      {!localMode && (
        <Button
          variant="destructive"
          onPress={handleSignOut}
          className="w-full"
        >
          Sign Out
        </Button>
      )}

      {/* Save changes bar */}
      {hasChanges && (
        <View className="bg-background border-t border-border px-4 py-3 flex-row items-center justify-between">
          <Text className="text-sm text-muted-foreground">
            You have unsaved changes
          </Text>
          <View className="flex-row items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onPress={() => setName(originalName)}
              disabled={isSaving}
            >
              Discard
            </Button>
            <Button
              size="sm"
              onPress={handleSave}
              disabled={
                !hasChanges || (hasNameChanges && !name.trim()) || isSaving
              }
            >
              {isSaving ? "Saving..." : "Save changes"}
            </Button>
          </View>
        </View>
      )}
    </View>
  );
}

// ============================================================================
// BILLING TAB
// ============================================================================

// Read-only dashboard of the child workspaces that pool a Business/Enterprise
// workspace's plan, plus a free "create workspace" affordance for admins. The
// child workspaces share the parent's plan, usage wallet, and seats.
const WorkspaceFamilySection = observer(function WorkspaceFamilySection({
  workspaceId,
  planId,
}: {
  workspaceId: string;
  planId: string;
}) {
  const http = useDomainHttp();
  const { user } = useAuth();
  const workspaces = useWorkspaceCollection();
  const toast = useToast();

  const [data, setData] = useState<WorkspaceChildrenResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!http || !workspaceId) return;
    setLoading(true);
    try {
      const res = await api.getWorkspaceChildren(http, workspaceId);
      setData(res ?? null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [http, workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  // Prefer the server-resolved effective plan (covers enterprise-via-grant,
  // where the local subscription planId is "free"); fall back to the prop.
  const effectivePlan = data?.parent.plan ?? planId;
  const planAllowsChildren =
    effectivePlan.startsWith("business") ||
    effectivePlan.startsWith("enterprise");

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name || !http || !user?.id || creating) return;
    setCreating(true);
    try {
      await api.createChildWorkspace(http, {
        name,
        parentWorkspaceId: workspaceId,
        ownerId: user.id,
      });
      setNewName("");
      await load();
      // Refresh the global collection so the new workspace shows in the switcher.
      try {
        await workspaces.loadAll();
      } catch {}
      toast.show({
        placement: "top",
        duration: 4000,
        render: ({ id }: { id: string }) => (
          <Toast nativeID={id} variant="outline" action="success">
            <ToastTitle>Workspace created</ToastTitle>
            <ToastDescription>
              “{name}” shares this plan&apos;s usage and seats.
            </ToastDescription>
          </Toast>
        ),
      });
    } catch (err: any) {
      const msg = err?.message?.includes("plan_required")
        ? "Additional workspaces are included on Business and Enterprise plans only."
        : "Could not create the workspace. Please try again.";
      toast.show({
        placement: "top",
        duration: 5000,
        render: ({ id }: { id: string }) => (
          <Toast nativeID={id} variant="outline" action="error">
            <ToastTitle>Failed to create workspace</ToastTitle>
            <ToastDescription>{msg}</ToastDescription>
          </Toast>
        ),
      });
    } finally {
      setCreating(false);
    }
  }, [newName, http, user?.id, creating, workspaceId, load, workspaces, toast]);

  // Hide entirely for plans that can't have children and have none.
  if (!planAllowsChildren && (!data || data.children.length === 0)) return null;

  const children = data?.children ?? [];

  return (
    <Card>
      <CardContent className="p-4 gap-3">
        <View className="gap-1">
          <Text className="text-sm font-semibold text-foreground">
            Workspaces
          </Text>
          <Text className="text-xs text-muted-foreground">
            {planAllowsChildren
              ? "Create additional workspaces at no extra cost. They share this plan\u2019s usage, billing, and seats. You can view their usage here."
              : "These workspaces share this plan\u2019s usage, billing, and seats."}
          </Text>
        </View>

        {loading ? (
          <View className="py-4 items-center">
            <ActivityIndicator />
          </View>
        ) : children.length === 0 ? (
          <Text className="text-xs text-muted-foreground">
            No additional workspaces yet.
          </Text>
        ) : (
          <View className="gap-2">
            {children.map((child) => (
              <View
                key={child.id}
                className="flex-row items-center justify-between rounded-lg border border-border p-3"
              >
                <View className="flex-1 pr-3">
                  <Text
                    className="text-sm font-medium text-foreground"
                    numberOfLines={1}
                  >
                    {child.name}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {child.memberCount}{" "}
                    {child.memberCount === 1 ? "member" : "members"}
                  </Text>
                </View>
                <View className="items-end">
                  <Text className="text-xs text-muted-foreground">
                    This month
                  </Text>
                  <Text className="text-sm font-medium text-foreground">
                    {formatUsd(child.usageThisMonthUsd)}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {planAllowsChildren && (
          <>
            <Separator />
            <View className="flex-row items-center gap-2">
              <View className="flex-1">
                <Input
                  placeholder="New workspace name"
                  value={newName}
                  onChangeText={setNewName}
                  disabled={creating}
                  onSubmitEditing={handleCreate}
                />
              </View>
              <Button
                variant="default"
                onPress={handleCreate}
                disabled={creating || newName.trim().length === 0}
              >
                <Text className="text-primary-foreground font-medium text-sm">
                  {creating ? "Creating…" : "Create"}
                </Text>
              </Button>
            </View>
          </>
        )}
      </CardContent>
    </Card>
  );
});

function BillingTab() {
  const { CreditCard } = useSettingsIcons();
  const router = useRouter();
  const http = useDomainHttp();
  const workspace = useActiveWorkspace();
  const { subscription, effectiveBalance, usageWindows, refetchUsageWallet } =
    useBillingData(workspace?.id);
  const [instanceLabel, setInstanceLabel] = useState<string | null>(null);
  const [spendLimitOpen, setSpendLimitOpen] = useState(false);

  // Coupled window display + single at-limit notice (overage vs paused).
  const billingWindowDisplays = getWindowDisplays(usageWindows);
  const billingUsageLimitNotice = getUsageLimitNotice({
    atLimit:
      billingWindowDisplays.fiveHour.atLimit ||
      billingWindowDisplays.weekly.atLimit,
    overage: effectiveBalance
      ? {
          enabled: effectiveBalance.overageEnabled,
          active: effectiveBalance.overageActive,
          accumulatedUsd: effectiveBalance.overageAccumulatedUsd,
        }
      : undefined,
    countdown: billingWindowDisplays.weekly.atLimit
      ? billingWindowDisplays.weekly.countdown
      : billingWindowDisplays.fiveHour.countdown,
  });
  // Surface the expired-entitlement state even before a window is exhausted,
  // so the user isn't only told about it once they hit the wall.
  const overageEntitlementExpired =
    !!effectiveBalance?.overageEnabled &&
    effectiveBalance.overageActive === false;

  useEffect(() => {
    if (!workspace?.id) return;
    let cancelled = false;
    api
      .getWorkspaceInstance(http, workspace.id)
      .then((inst: any) => {
        if (cancelled || !inst) return;
        const size = inst.size ?? "micro";
        const labels: Record<string, string> = {
          micro: "Micro (0.5 CPU, 2 GB)",
          small: "Small (1 CPU, 4 GB)",
          medium: "Medium (2 CPU, 8 GB)",
          large: "Large (4 CPU, 16 GB)",
          xlarge: "XLarge (8 CPU, 32 GB)",
        };
        setInstanceLabel(labels[size] ?? size);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [http, workspace?.id]);

  const handleManageUsageOnWeb = useCallback(() => {
    openWebAppSession("/settings?tab=billing").catch((err) =>
      console.warn("[BillingTab] failed to open web billing:", err)
    );
  }, []);

  const planId = subscription?.planId?.toLowerCase() ?? "free";
  const planLabel = planId.startsWith("enterprise")
    ? "Enterprise"
    : planId.startsWith("business")
    ? "Business"
    : planId.startsWith("pro")
    ? "Pro"
    : planId.startsWith("basic")
    ? "Basic"
    : "Free";
  const hasActiveSubscription =
    subscription?.status === "active" || subscription?.status === "trialing";
  const canUseOverage = hasActiveSubscription;

  if (!workspace?.id) {
    return (
      <View className="py-12 items-center">
        <Text className="text-sm text-muted-foreground">
          No workspace selected
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-4">
      <View>
        <Text className="text-lg font-bold text-foreground mb-1">Billing</Text>
        <Text className="text-xs text-muted-foreground">
          {Platform.OS === "ios"
            ? "Manage your plan and usage. For detailed analytics, see the Usage tab."
            : "Manage your plan and on-demand spending cap. For detailed analytics, see the Usage tab."}
        </Text>
      </View>

      <Card>
        <CardContent className="p-4 gap-3">
          <View className="flex-row items-center justify-between">
            <View className="gap-1">
              <Text className="text-xs text-muted-foreground">
                Current Plan
              </Text>
              <View className="flex-row items-center gap-2">
                <Text className="text-lg font-bold text-foreground">
                  {planLabel}
                </Text>
                {hasActiveSubscription && (
                  <Badge variant="secondary">
                    <Text className="text-xs">
                      {subscription?.status === "trialing" ? "Trial" : "Active"}
                    </Text>
                  </Badge>
                )}
              </View>
            </View>
            <CreditCard size={20} className="text-muted-foreground" />
          </View>

          <Separator />

          <View className="gap-3">
            {(["fiveHour", "weekly"] as const).map((key) => {
              const w = usageWindows?.[key];
              const label =
                key === "fiveHour" ? "5-hour usage" : "Weekly usage";
              const display = billingWindowDisplays[key];
              const { pct, uncapped, countdown } = display;
              return (
                <View key={key} className="gap-1">
                  <View className="flex-row items-center justify-between">
                    <Text className="text-sm text-muted-foreground">
                      {label}
                    </Text>
                    <Text className="text-sm font-medium text-foreground">
                      {!w ? "—" : uncapped ? "Unlimited" : `${pct}% used`}
                    </Text>
                  </View>
                  {!uncapped && (
                    <View className="h-2 bg-muted rounded-full overflow-hidden">
                      <View
                        className={cn(
                          "h-full rounded-full",
                          pct >= 100 ? "bg-destructive" : "bg-primary"
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </View>
                  )}
                  {!uncapped && countdown ? (
                    <Text className="text-xs text-muted-foreground">
                      {pct >= 100
                        ? `Limit reached — resets in ${countdown}`
                        : `Resets in ${countdown}`}
                    </Text>
                  ) : null}
                </View>
              );
            })}
            {billingUsageLimitNotice ? (
              <Text
                className={cn(
                  "text-xs",
                  billingUsageLimitNotice.tone === "overage" ||
                    billingUsageLimitNotice.tone === "expired"
                    ? "text-foreground font-medium"
                    : "text-muted-foreground"
                )}
              >
                {billingUsageLimitNotice.text}
              </Text>
            ) : null}
            {!billingUsageLimitNotice && overageEntitlementExpired && (
              <Text className="text-xs text-foreground font-medium">
                Your on-demand billing entitlement has expired. Reactivate your
                subscription or license to keep using on-demand usage.
              </Text>
            )}
            {Platform.OS !== "ios" &&
              !billingUsageLimitNotice &&
              effectiveBalance?.overageEnabled &&
              effectiveBalance.overageAccumulatedUsd > 0 && (
                <Text className="text-xs text-muted-foreground">
                  Overage this period:{" "}
                  {formatUsd(effectiveBalance.overageAccumulatedUsd)} (billed in
                  trust blocks: $100 → $500)
                </Text>
              )}
          </View>

          {instanceLabel && (
            <>
              <Separator />
              <View className="flex-row items-center justify-between">
                <Text className="text-sm text-muted-foreground">Instance</Text>
                <Text className="text-sm font-medium text-foreground">
                  {instanceLabel}
                </Text>
              </View>
            </>
          )}

          <Separator />

          <View className="flex-row items-center gap-2">
            <Button
              variant="default"
              onPress={() => router.push("/(app)/billing" as any)}
              className="flex-1"
            >
              <Text className="text-primary-foreground font-medium">
                Manage Plan
              </Text>
            </Button>
            <Button
              variant="outline"
              onPress={() =>
                router.push("/(app)/settings?tab=analytics" as any)
              }
              className="flex-1"
            >
              <Text className="text-foreground font-medium">
                View detailed usage
              </Text>
            </Button>
          </View>
        </CardContent>
      </Card>

      <WorkspaceFamilySection workspaceId={workspace.id} planId={planId} />

      {canUseOverage && Platform.OS === "ios" && (
        <Card>
          <CardContent className="p-4 gap-3">
            <View className="gap-1">
              <Text className="text-sm font-semibold text-foreground">
                Usage payments
              </Text>
              <Text className="text-xs text-muted-foreground">
                Usage beyond your included monthly amount is managed from your
                web account.
              </Text>
            </View>
            <Button variant="outline" onPress={handleManageUsageOnWeb}>
              <Text className="text-foreground font-medium text-sm">
                Manage usage & payments on the web
              </Text>
            </Button>
          </CardContent>
        </Card>
      )}

      {canUseOverage && Platform.OS !== "ios" && (
        <Card>
          <CardContent className="p-4 gap-3">
            <View className="gap-1">
              <Text className="text-sm font-semibold text-foreground">
                Spending limit
              </Text>
              <Text className="text-xs text-muted-foreground">
                You keep working when your included usage runs out — we charge
                the saved card in trust blocks billed at provider cost + 20%.
                Blocks start at $100 and step up by $100 as you build payment
                history (capped at $500 per charge).
              </Text>
            </View>

            <View className="flex-row items-center justify-between">
              <View>
                <Text className="text-xs text-muted-foreground">
                  Monthly spending cap
                </Text>
                <Text className="text-base font-semibold text-foreground">
                  {effectiveBalance?.overageHardLimitUsd != null
                    ? formatUsd(effectiveBalance.overageHardLimitUsd)
                    : "No cap"}
                </Text>
              </View>
              <Button variant="outline" onPress={() => setSpendLimitOpen(true)}>
                <Text className="text-foreground font-medium text-sm">
                  Set Limit
                </Text>
              </Button>
            </View>
          </CardContent>
        </Card>
      )}

      {Platform.OS !== "ios" && (
        <SetSpendLimitDialog
          visible={spendLimitOpen}
          onClose={() => setSpendLimitOpen(false)}
          workspaceId={workspace.id}
          currentLimitUsd={effectiveBalance?.overageHardLimitUsd ?? null}
          accumulatedUsageUsd={effectiveBalance?.overageAccumulatedUsd ?? 0}
          onSaved={() => refetchUsageWallet()}
        />
      )}
    </View>
  );
}

// ============================================================================
// WORKSPACE ANALYTICS TAB
// ============================================================================

interface SpendTimeseriesPayload {
  days: { date: string; byModel: Record<string, number>; total: number }[];
  totals: {
    totalSpendUsd: number;
    totalIncludedUsd: number;
    totalOnDemandUsd: number;
    uniqueModels: number;
  };
  models: string[];
  groupBy: "model" | "user" | "source";
  metric: "spend" | "tokens" | "requests";
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function WorkspaceAnalyticsTab() {
  const { Coins, CreditCard, Download, Zap } = useSettingsIcons();
  const http = useDomainHttp();
  const router = useRouter();
  const workspace = useActiveWorkspace();
  const workspaceId = workspace?.id;
  const { localMode } = usePlatformConfig();
  const { subscription, effectiveBalance, usageWindows, refetchUsageWallet } =
    useBillingData(workspaceId);
  const cloudBilling = useCloudBillingSummary(localMode);
  // Warm the visible-models metadata cache so chart series can be labeled with
  // model display names (e.g. "Hoshi 1.0") rather than raw ids (mimo-v2.5).
  useVisibleModels();

  const planId = subscription?.planId?.toLowerCase() ?? "";
  const isBusinessOrHigher =
    localMode ||
    planId.startsWith("business") ||
    planId.startsWith("enterprise");

  const [period, setPeriod] = useState<AnalyticsPeriod>("7d");
  const [logPage, setLogPage] = useState(1);
  const [groupBy, setGroupBy] = useState<SpendGroupBy>("model");
  const [metric, setMetric] = useState<SpendMetric>("spend");
  const [spendLimitOpen, setSpendLimitOpen] = useState(false);

  const [usageSummary, setUsageSummary] = useState<{
    data: UsageSummaryData | null;
    loading: boolean;
  }>({ data: null, loading: true });
  const [usageLog, setUsageLog] = useState<{
    data: UsageLogData | null;
    loading: boolean;
  }>({ data: null, loading: true });
  const [spend, setSpend] = useState<{
    data: SpendTimeseriesPayload | null;
    loading: boolean;
  }>({ data: null, loading: true });
  const [usage, setUsage] = useState<{
    data: UsageBreakdownData | null;
    loading: boolean;
  }>({ data: null, loading: true });
  const [chatStats, setChatStats] = useState<{
    data: ChatAnalyticsData | null;
    loading: boolean;
  }>({ data: null, loading: true });

  const loadAll = useCallback(async () => {
    if (!workspaceId) return;
    const p = { period };

    setUsageSummary((s) => ({ ...s, loading: true }));
    setUsageLog((s) => ({ ...s, loading: true }));
    setSpend((s) => ({ ...s, loading: true }));

    const basicFetches = [
      api
        .getWorkspaceAnalytics<UsageSummaryData>(
          http,
          workspaceId,
          "usage-summary",
          p
        )
        .catch(() => null),
      api
        .getWorkspaceAnalytics<UsageLogData>(http, workspaceId, "usage-log", {
          ...p,
          page: String(logPage),
          limit: "50",
        })
        .catch(() => null),
      api
        .getWorkspaceAnalytics<SpendTimeseriesPayload>(
          http,
          workspaceId,
          "spend-timeseries",
          { ...p, groupBy, metric }
        )
        .catch(() => null),
    ] as const;

    if (isBusinessOrHigher) {
      setUsage((s) => ({ ...s, loading: true }));
      setChatStats((s) => ({ ...s, loading: true }));

      const [uSum, uLog, sp, us, ch] = await Promise.all([
        ...basicFetches,
        api
          .getWorkspaceAnalytics<UsageBreakdownData>(
            http,
            workspaceId,
            "usage",
            p
          )
          .catch(() => null),
        api
          .getWorkspaceAnalytics<ChatAnalyticsData>(
            http,
            workspaceId,
            "chat",
            p
          )
          .catch(() => null),
      ]);

      setUsageSummary({ data: uSum, loading: false });
      setUsageLog({ data: uLog, loading: false });
      setSpend({ data: sp, loading: false });
      setUsage({ data: us, loading: false });
      setChatStats({ data: ch, loading: false });
    } else {
      const [uSum, uLog, sp] = await Promise.all(basicFetches);
      setUsageSummary({ data: uSum, loading: false });
      setUsageLog({ data: uLog, loading: false });
      setSpend({ data: sp, loading: false });
    }
  }, [http, workspaceId, period, logPage, groupBy, metric, isBusinessOrHigher]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  if (!workspaceId) {
    return (
      <View className="py-12 items-center">
        <Text className="text-sm text-muted-foreground">
          No workspace selected
        </Text>
      </View>
    );
  }

  // ─── Progress card data ──────────────────────────────────
  // Coupled window display: weekly-at-100% forces the 5-hour card to 100% too.
  // In local mode usage is metered against the linked Shogo Cloud workspace,
  // so read windows from the cloud billing summary, not the local plan.
  const cloudPlan = cloudBilling.summary?.plan;
  const displayWindows = localMode
    ? (cloudPlan?.usageWindows as typeof usageWindows)
    : usageWindows;
  const analyticsWindowDisplays = getWindowDisplays(displayWindows);
  const onDemandUsed = localMode
    ? cloudPlan?.overageAccumulatedUsd ?? 0
    : effectiveBalance?.overageAccumulatedUsd ?? 0;
  const onDemandLimit = localMode
    ? cloudPlan?.overageHardLimitUsd ?? null
    : effectiveBalance?.overageHardLimitUsd ?? null;
  const onDemandPct =
    onDemandLimit && onDemandLimit > 0
      ? Math.min(100, (onDemandUsed / onDemandLimit) * 100)
      : onDemandUsed > 0
      ? Math.min(100, (onDemandUsed / 1000) * 100)
      : 0;

  // ─── Summary cards ───────────────────────────────────────
  const totalSpend = spend.data?.totals.totalSpendUsd ?? 0;
  const includedSpend = spend.data?.totals.totalIncludedUsd ?? 0;
  const onDemandSpend = spend.data?.totals.totalOnDemandUsd ?? 0;

  const csvUrl = api.getUsageLogCsvUrl(workspaceId, { period });
  const handleExportCsv = () => {
    if (typeof window !== "undefined") {
      window.open(csvUrl, "_blank", "noopener");
    } else {
      Linking.openURL(csvUrl);
    }
  };

  return (
    <View className="gap-4">
      <View>
        <Text className="text-lg font-bold text-foreground mb-1">Usage</Text>
        <Text className="text-xs text-muted-foreground">
          {localMode
            ? "Token usage and agent activity for this workspace"
            : "Usage metrics and spend for this workspace"}
        </Text>
      </View>

      {/* Who is doing what: team table + dashboard for admins, own stats for members */}
      {workspaceId ? (
        <WorkspaceActivitySection
          workspaceId={workspaceId}
          isBusinessOrHigher={isBusinessOrHigher}
        />
      ) : null}

      {/* Progress cards */}
      <View className="flex-row flex-wrap gap-3">
        {(["fiveHour", "weekly"] as const).map((key) => {
          const w = displayWindows?.[key];
          const label = key === "fiveHour" ? "5-hour usage" : "Weekly usage";
          const { pct, uncapped, countdown } = analyticsWindowDisplays[key];
          return (
            <BillingProgressCard
              key={key}
              title={label}
              current={!w ? "—" : uncapped ? "Unlimited" : `${pct}%`}
              total={null}
              percent={uncapped ? 0 : pct}
              tone={
                pct >= 100 ? "destructive" : pct >= 90 ? "warning" : "primary"
              }
              helper={
                uncapped
                  ? "Unlimited — no usage window"
                  : countdown
                  ? pct >= 100
                    ? `Limit reached — resets in ${countdown}`
                    : `Resets in ${countdown}`
                  : "Window not started"
              }
            />
          );
        })}
        <BillingProgressCard
          title="On-Demand Usage (Team)"
          current={fmtUsd(onDemandUsed)}
          total={onDemandLimit != null ? fmtUsd(onDemandLimit) : null}
          percent={onDemandPct}
          tone={onDemandPct > 80 ? "warning" : "primary"}
          helper="Pay for extra usage beyond your plan limits."
          subHelper={
            onDemandLimit != null
              ? `${fmtUsd(onDemandLimit)} team spend cap`
              : "No spend cap set"
          }
          {...(Platform.OS !== "ios" &&
          (!localMode ||
            (cloudBilling.summary?.signedIn === true &&
              cloudBilling.summary.plan?.paidTier === true))
            ? {
                actionLabel: "Set Limit",
                onActionPress: () => setSpendLimitOpen(true),
              }
            : {})}
        />
      </View>

      {/* Date range pills */}
      <View className="flex-row items-center justify-between flex-wrap gap-3">
        <DateRangePills value={period} onChange={setPeriod} />
      </View>

      {/* Summary cards */}
      <View className="flex-row flex-wrap gap-2">
        <StatCard label="Total spend" value={fmtUsd(totalSpend)} icon={Coins} />
        <StatCard
          label="Included"
          value={fmtUsd(includedSpend)}
          icon={CreditCard}
        />
        <StatCard label="On-demand" value={fmtUsd(onDemandSpend)} icon={Zap} />
      </View>

      {/* Team Usage chart */}
      <UsageTimeseriesChart
        data={spend.data}
        loading={spend.loading}
        groupBy={groupBy}
        metric={metric}
        onGroupByChange={setGroupBy}
        onMetricChange={setMetric}
        isLocalMode={localMode}
        title="Team Usage"
        subtitle="Team usage per day across this billing period"
        groupByOptions={["model", "user", "source"]}
        showTotals={false}
      />

      {/* Event log + CSV export */}
      <View className="gap-2">
        <View className="flex-row items-center justify-end">
          <Pressable
            onPress={handleExportCsv}
            className="flex-row items-center gap-1.5 px-3 h-8 rounded-md border border-border bg-background active:bg-muted"
          >
            <Download size={14} className="text-foreground" />
            <Text className="text-xs font-medium text-foreground">
              Export CSV
            </Text>
          </Pressable>
        </View>
        <UsageTableSection
          summaryData={usageSummary.data}
          logData={usageLog.data}
          summaryLoading={usageSummary.loading}
          logLoading={usageLog.loading}
          onLogPageChange={setLogPage}
          logPage={logPage}
          isLocalMode={localMode}
        />
      </View>

      {/* Leaderboard (Image 2) */}
      <UsageLeaderboard
        data={usageSummary.data}
        loading={usageSummary.loading}
      />

      {isBusinessOrHigher && (
        <>
          <ChatAnalyticsSection
            data={chatStats.data}
            loading={chatStats.loading}
          />
          <UsageBreakdownSection data={usage.data} loading={usage.loading} />
        </>
      )}

      {Platform.OS !== "ios" && (
        <SetSpendLimitDialog
          visible={spendLimitOpen}
          onClose={() => setSpendLimitOpen(false)}
          workspaceId={workspaceId}
          currentLimitUsd={onDemandLimit}
          accumulatedUsageUsd={onDemandUsed}
          onSave={localMode ? cloudBilling.setSpendingLimit : undefined}
          onSaved={() => {
            if (localMode) {
              void cloudBilling.refresh();
            } else {
              refetchUsageWallet();
            }
          }}
        />
      )}
    </View>
  );
}

// ============================================================================
// COST OPTIMIZER TAB
// ============================================================================

function WorkspaceCostTab() {
  const http = useDomainHttp();
  const workspace = useActiveWorkspace();
  const workspaceId = workspace?.id;

  const fetchCostAnalytics = useCallback(
    <T,>(endpoint: string, params?: Record<string, string>) =>
      api.getWorkspaceCostAnalytics<T>(http, workspaceId!, endpoint, params),
    [http, workspaceId]
  );

  const postCostAnalytics = useCallback(
    <T,>(endpoint: string, body: Record<string, unknown>) =>
      api.postWorkspaceCostAnalytics<T>(http, workspaceId!, endpoint, body),
    [http, workspaceId]
  );

  const fetchSubagentOverrides = useCallback(
    () => api.listSubagentOverrides(http, workspaceId!),
    [http, workspaceId]
  );

  const putSubagentOverride = useCallback(
    (body: {
      agentType: string;
      model: string;
      provider?: string | null;
      projectId?: string | null;
    }) => api.upsertSubagentOverride(http, workspaceId!, body),
    [http, workspaceId]
  );

  const deleteSubagentOverride = useCallback(
    (agentType: string, projectId?: string | null) =>
      api.deleteSubagentOverride(http, workspaceId!, agentType, projectId),
    [http, workspaceId]
  );

  if (!workspaceId) {
    return (
      <View className="py-12 items-center">
        <Text className="text-sm text-muted-foreground">
          No workspace selected
        </Text>
      </View>
    );
  }

  return (
    <CostAnalyticsTab
      workspaceId={workspaceId}
      fetchCostAnalytics={fetchCostAnalytics}
      postCostAnalytics={postCostAnalytics}
      fetchSubagentOverrides={fetchSubagentOverrides}
      putSubagentOverride={putSubagentOverride}
      deleteSubagentOverride={deleteSubagentOverride}
    />
  );
}

// ============================================================================
// MAIN SETTINGS PAGE
// ============================================================================

export function WorkspaceAccountActions({
  onSelectTab,
  showWorkspace = true,
  showActions = true,
  showSignOut = true,
  showActionsHeading = true,
  variant = "default",
}: {
  onSelectTab?: (tab: TabId) => void;
  showWorkspace?: boolean;
  showActions?: boolean;
  showSignOut?: boolean;
  showActionsHeading?: boolean;
  variant?: "default" | "sidebar";
}) {
  const router = useRouter();
  const { signOut, user } = useAuth();
  const { features, localMode } = usePlatformConfig();
  const workspaces = useWorkspaceCollection();
  const projects = useProjectCollection();
  const actions = useDomainActions();
  const posthog = usePostHogSafe();
  const currentWorkspace = useActiveWorkspace();
  const allWorkspaces = workspaces?.all ?? [];
  // See `AppSidebar.tsx`'s `hasTeamWorkspace` for why this gates the free
  // vs. paid "Create new workspace" flow.
  const hasTeamWorkspace = allWorkspaces.some(
    (w: { kind?: string }) => w.kind === "team"
  );
  const { parent: pooledWorkspaceParent, createPooledWorkspace } =
    usePooledWorkspaceCreation({
      workspaces: allWorkspaces,
      currentWorkspaceId: currentWorkspace?.id,
      enabled: !!features.billing,
    });
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);

  const switchWorkspace = useCallback(
    (workspaceId: string) => {
      if (workspaceId === currentWorkspace?.id) return;
      scheduleWorkspaceSwitch(workspaceId, projects, reloadAfterWorkspaceSwitch);
    },
    [currentWorkspace?.id, projects]
  );

  const createWorkspace = useCallback(() => {
    if (pooledWorkspaceParent) {
      setCreateWorkspaceOpen(true);
    } else if (hasTeamWorkspace) {
      router.push("/(app)/new-workspace" as any);
      return;
    } else {
      setCreateWorkspaceOpen(true);
    }
  }, [hasTeamWorkspace, pooledWorkspaceParent, router]);

  const handleCreateWorkspaceSubmit = useCallback(
    async (name: string) => {
      if (pooledWorkspaceParent) return createPooledWorkspace(name);
      if (!user?.id) return;
      try {
        const created = await actions.createWorkspace(name, undefined, user.id);
        if (created?.id) {
          trackEvent(posthog, EVENTS.WORKSPACE_CREATED);
          setActiveWorkspaceId(created.id);
          await workspaces.loadAll();
          projects.clear();
          await projects.loadAll({ workspaceId: created.id });
        }
      } catch (err) {
        console.warn("Failed to create workspace:", err);
      }
    },
    [
      actions,
      createPooledWorkspace,
      pooledWorkspaceParent,
      posthog,
      projects,
      user?.id,
      workspaces,
    ]
  );

  const go = useCallback((href: string) => router.push(href as any), [router]);
  const sidebar = variant === "sidebar";

  return (
    <View className={cn(sidebar ? "gap-0.5" : "mb-8 gap-4")}>
      {showWorkspace ? (
        <View>
          <Text
            className={cn(
              "text-xs font-semibold uppercase tracking-wide text-muted-foreground",
              sidebar && "mb-2 px-2"
            )}
          >
            Workspace
          </Text>
          <View
            className={cn(
              !sidebar && "mt-2 gap-1 rounded-xl bg-muted/40 p-1",
              sidebar && "gap-0.5"
            )}
          >
            {allWorkspaces.map((workspace: any) => {
              const isCurrent = workspace.id === currentWorkspace?.id;
              return (
                <Pressable
                  key={workspace.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isCurrent }}
                  accessibilityLabel={`Switch to ${
                    workspace.name || "workspace"
                  }`}
                  onPress={() =>
                    isCurrent
                      ? onSelectTab?.("workspace")
                      : switchWorkspace(workspace.id)
                  }
                  className={cn(
                    sidebar
                      ? "flex-row items-center gap-2 rounded-lg px-2.5 py-2.5 active:bg-muted"
                      : "flex-row items-center gap-3 rounded-lg px-3 py-2.5 active:bg-muted",
                    isCurrent &&
                      (sidebar
                        ? "border border-primary/20 bg-primary/5"
                        : "bg-background")
                  )}
                >
                  <View
                    className={cn(
                      "items-center justify-center rounded-lg bg-primary/10",
                      sidebar ? "h-5 w-5" : "h-8 w-8"
                    )}
                  >
                    <Text
                      className={cn(
                        "font-semibold text-primary",
                        sidebar ? "text-[10px]" : "text-sm"
                      )}
                    >
                      {workspace.name?.[0]?.toUpperCase() || "W"}
                    </Text>
                  </View>
                  <Text
                    className="flex-1 text-sm font-medium text-foreground"
                    numberOfLines={1}
                  >
                    {workspace.name || "Untitled workspace"}
                  </Text>
                  {isCurrent ? (
                    <Text
                      className={cn(
                        "font-medium text-primary",
                        sidebar ? "text-[10px]" : "text-xs"
                      )}
                    >
                      Current
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create new workspace"
              onPress={createWorkspace}
              className={cn(
                sidebar
                  ? "flex-row items-center gap-2 rounded-lg px-2.5 py-2.5 active:bg-muted"
                  : "flex-row items-center gap-3 rounded-lg px-3 py-2.5 active:bg-muted"
              )}
            >
              <PlusIcon size={18} className="text-muted-foreground" />
              <Text className="text-sm font-medium text-foreground">
                Create new workspace
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {showActions ? (
        <View className={cn(sidebar && "mt-6")}>
          {showActionsHeading ? (
            <Text
              className={cn(
                "text-xs font-semibold uppercase tracking-wide text-muted-foreground",
                sidebar && "mb-2 px-2"
              )}
            >
              Workspace actions
            </Text>
          ) : null}
          <View className={cn(!sidebar && "mt-2 gap-1", sidebar && "gap-0.5")}>
            {!localMode && features.billing ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Invite workspace members"
                onPress={() => onSelectTab?.("people")}
                className={cn(
                  sidebar
                    ? "flex-row items-center gap-2 rounded-lg px-2.5 py-2.5 active:bg-muted"
                    : "flex-row items-center gap-3 rounded-lg px-3 py-2.5 active:bg-muted"
                )}
              >
                <UserPlusIcon size={18} className="text-muted-foreground" />
                <Text className="flex-1 text-sm text-foreground">Invite</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Manage API keys"
              onPress={() => go("/(app)/api-keys")}
              className={cn(
                sidebar
                  ? "flex-row items-center gap-2 rounded-lg px-2.5 py-2.5 active:bg-muted"
                  : "flex-row items-center gap-3 rounded-lg px-3 py-2.5 active:bg-muted"
              )}
            >
              <KeyRoundIcon size={18} className="text-muted-foreground" />
              <Text className="flex-1 text-sm text-foreground">API Keys</Text>
            </Pressable>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Open documentation"
              onPress={() => void Linking.openURL(DOCS_URL)}
              className={cn(
                sidebar
                  ? "flex-row items-center gap-2 rounded-lg px-2.5 py-2.5 active:bg-muted"
                  : "flex-row items-center gap-3 rounded-lg px-3 py-2.5 active:bg-muted"
              )}
            >
              <ExternalLinkIcon size={18} className="text-muted-foreground" />
              <Text className="flex-1 text-sm text-foreground">Docs</Text>
            </Pressable>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Open What's New"
              onPress={() => void Linking.openURL(CHANGELOG_URL)}
              className={cn(
                sidebar
                  ? "flex-row items-center gap-2 rounded-lg px-2.5 py-2.5 active:bg-muted"
                  : "flex-row items-center gap-3 rounded-lg px-3 py-2.5 active:bg-muted"
              )}
            >
              <ZapIcon size={18} className="text-muted-foreground" />
              <Text className="flex-1 text-sm text-foreground">What's New</Text>
            </Pressable>
            {latestAnnouncedRelease && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Replay What's New"
                onPress={() =>
                  router.push({
                    pathname: "/(app)/settings",
                    params: { whatsNew: latestAnnouncedRelease.version },
                  } as any)
                }
                className={cn(
                  sidebar
                    ? "ml-8 flex-row items-center gap-2 rounded-lg px-2.5 py-2 active:bg-muted"
                    : "ml-9 flex-row items-center gap-3 rounded-lg px-3 py-2 active:bg-muted"
                )}
              >
                <SparklesIcon size={16} className="text-primary-500" />
                <Text className="flex-1 text-xs text-muted-foreground">
                  Replay latest announcement
                </Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Open Creator"
              onPress={() => go("/(app)/creator")}
              className={cn(
                sidebar
                  ? "flex-row items-center gap-2 rounded-lg px-2.5 py-2.5 active:bg-muted"
                  : "flex-row items-center gap-3 rounded-lg px-3 py-2.5 active:bg-muted"
              )}
            >
              <BoxesIcon size={18} className="text-muted-foreground" />
              <Text className="flex-1 text-sm text-foreground">Creator</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {showSignOut ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          onPress={() => void signOut()}
          className={cn(
            sidebar
              ? "mt-6 flex-row items-center gap-2 rounded-lg px-2.5 py-2.5 active:bg-destructive/10"
              : "flex-row items-center gap-3 rounded-lg py-2.5 active:bg-destructive/10"
          )}
        >
          <LogOutIcon size={18} className="text-destructive" />
          <Text className="text-sm font-medium text-destructive">Sign out</Text>
        </Pressable>
      ) : null}
      <CreateWorkspaceModal
        visible={createWorkspaceOpen}
        onClose={() => setCreateWorkspaceOpen(false)}
        onSubmit={handleCreateWorkspaceSubmit}
        parentName={pooledWorkspaceParent?.name}
      />
    </View>
  );
}

export const SettingsContent = observer(function SettingsContent({
  activeTab,
  localMode = false,
  onSelectTab,
  onClose,
}: {
  activeTab: TabId;
  localMode?: boolean;
  onSelectTab?: (tab: TabId) => void;
  /** Set when Settings is shown in a sheet that must close before navigating away. */
  onClose?: () => void;
}) {
  const isLocal = localMode;
  return (
    <>
      {activeTab === "workspace" && <WorkspaceSettingsTab />}
      {activeTab === "people" && !isLocal && <PeopleTab />}
      {activeTab === "models" && !isLocal && <WorkspaceModelsTab />}
      {activeTab === "integrations" && <IntegrationsTab />}
      {activeTab === "automations" && (
        <AutomationsTab
          onOpenIntegrations={onSelectTab ? () => onSelectTab("integrations") : undefined}
          onLeaveSettings={onClose}
        />
      )}
      {activeTab === "remote-control" && <RemoteControlTab />}
      {activeTab === "account" && <AccountTab />}
      {activeTab === "appearance" && <AppearanceTab />}
      {activeTab === "security" && <SecuritySettingsPanel />}
      {activeTab === "computer-files" && isLocal && IS_DESKTOP_CLIENT && (
        <ComputerAndFilesPanel />
      )}
      {activeTab === "compute" &&
        !isLocal &&
        !HIDE_COMPUTE_PURCHASES_ON_IOS && <ComputeTab />}
      {activeTab === "billing" &&
        (isLocal ? <LocalCloudBillingTab /> : <BillingTab />)}
      {activeTab === "analytics" && <WorkspaceAnalyticsTab />}
      {activeTab === "costs" && <WorkspaceCostTab />}
      {activeTab === "updates" && <UpdatesTab />}
    </>
  );
});

export default observer(function SettingsPage({
  onClose,
}: {
  onClose?: () => void;
}) {
  const { ExternalLink, ArrowLeft } = useSettingsIcons();
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string; workspace?: string }>();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isWide = width >= SETTINGS_WIDE_BREAKPOINT;
  const isNativePhone = isNativePhoneIntegrationsLayout(width, height);
  const { user } = useAuth();
  const workspaces = useWorkspaceCollection();
  const currentWorkspace = useActiveWorkspace();
  const { features, localMode } = usePlatformConfig();

  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const requested = params.tab as TabId;
    return ALL_TAB_IDS.includes(requested) ? requested : "workspace";
  });

  useEffect(() => {
    const requestedWorkspace = params.workspace;
    const ownWorkspaceIds =
      workspaces?.all?.map((workspace: any) => workspace.id) ?? [];
    if (!requestedWorkspace || ownWorkspaceIds.length === 0) return;
    const resolvedWorkspace = resolveActiveWorkspaceId(
      ownWorkspaceIds,
      requestedWorkspace,
      { listLoaded: true },
    );
    if (resolvedWorkspace) setActiveWorkspaceId(resolvedWorkspace);
  }, [params.workspace, workspaces?.all, workspaces?.isLoading]);

  useEffect(() => {
    const isLocal = localMode || !features.billing;
    if (activeTab === "people" && isLocal) setActiveTab("workspace");
    if (activeTab === "models" && isLocal) setActiveTab("workspace");
    if (activeTab === "compute" && (isLocal || HIDE_COMPUTE_PURCHASES_ON_IOS))
      setActiveTab("workspace");
    if (activeTab === "updates" && !IS_DESKTOP_CLIENT)
      setActiveTab("workspace");
    if (activeTab === "computer-files" && (!IS_DESKTOP_CLIENT || !isLocal))
      setActiveTab("workspace");
  }, [activeTab, features.billing, localMode]);

  const workspaceName = currentWorkspace?.name || "";
  const userName = user?.name || "";
  const activeTabLabel = settingsTab(activeTab).label;
  const exitSettings = () => {
    if (onClose) {
      onClose();
      return;
    }
    leaveSettings(router, isNativePhone);
  };

  if (isWide) {
    return (
      <View
        className="flex-1 flex-row bg-muted/30"
        style={{ paddingTop: insets.top }}
      >
        <View className="border-r border-border/70 bg-card">
          <SettingsSidebar
            activeTab={activeTab}
            onTabChange={setActiveTab}
            workspaceName={workspaceName}
            userName={userName}
            onExit={exitSettings}
            showBilling={features.billing}
            localMode={localMode}
          />
        </View>
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-8 py-8 xl:px-12"
          contentContainerStyle={{
            paddingBottom: Math.max(insets.bottom + 40, 60),
          }}
          showsVerticalScrollIndicator={false}
        >
          <View className="w-full max-w-[1080px] self-center">
            <View className="mb-6 flex-row items-end justify-between border-b border-border/70 pb-5">
              <View>
                <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Settings
                </Text>
                <Text className="mt-1 text-2xl font-semibold text-foreground">
                  {activeTabLabel}
                </Text>
              </View>
              <Pressable
                onPress={() => Linking.openURL(DOCS_URL)}
                className="flex-row items-center gap-1.5 rounded-lg px-2 py-1.5 active:bg-muted"
              >
                <ExternalLink size={14} className="text-muted-foreground" />
                <Text className="text-sm text-muted-foreground">Docs</Text>
              </Pressable>
            </View>
            <SettingsContent
              activeTab={activeTab}
              localMode={localMode || !features.billing}
              onSelectTab={setActiveTab}
            />
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-3 border-b border-border/70 bg-card px-4 py-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={exitSettings}
          className="h-10 w-10 items-center justify-center rounded-full active:bg-muted"
        >
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <View className="flex-1">
          <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Settings
          </Text>
          <Text className="text-xl font-semibold text-foreground">
            {activeTabLabel}
          </Text>
        </View>
      </View>

      <View className="z-10 bg-card">
        <TabBar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          showBilling={features.billing}
          localMode={localMode || !features.billing}
        />
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="px-4 pt-5"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom + 28, 40),
        }}
        showsVerticalScrollIndicator={false}
      >
        <View className="w-full self-center" style={{ maxWidth: 720 }}>
          <SettingsContent
            activeTab={activeTab}
            localMode={localMode || !features.billing}
            onSelectTab={setActiveTab}
          />
        </View>
      </ScrollView>
    </View>
  );
});
