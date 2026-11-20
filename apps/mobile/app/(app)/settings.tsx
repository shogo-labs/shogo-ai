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
  Platform,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { Redirect, useRouter, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { observer } from "mobx-react-lite";
import {
  ArrowLeft as ArrowLeftIcon,
  Building2 as Building2Icon,
  Users as UsersIcon,
  Boxes as BoxesIcon,
  Shield as ShieldIcon,
  ShieldCheck as ShieldCheckIcon,
  User as UserIcon,
  ExternalLink as ExternalLinkIcon,
  Trash2 as Trash2Icon,
  ChevronDown as ChevronDownIcon,
  X as XGlyph,
  Search as SearchIcon,
  UserPlus as UserPlusIcon,
  Mail as MailIcon,
  MessageSquare as MessageSquareIcon,
  Zap as ZapIcon,
  CreditCard as CreditCardIcon,
  Cloud as CloudIcon,
  Server as ServerIcon,
  Plug as PlugIcon,
  Download as DownloadIcon,
  Monitor as MonitorIcon,
  Laptop as LaptopIcon,
  HardDrive as HardDriveIcon,
  Paintbrush as PaintbrushIcon,
  RefreshCw as RefreshCwIcon,
  KeyRound as KeyRoundIcon,
  LogOut as LogOutIcon,
  Plus as PlusIcon,
  Sparkles as SparklesIcon,
} from "lucide-react-native";
import {
  Text,
  TextInput,
  useAccountSheetIcons,
} from "../../components/settings/account-sheet-chrome";
import { AppearanceTab } from "../../components/settings/AppearanceTab";
import { ChatPreferencesTab } from "../../components/settings/ChatPreferencesTab";
import { CreateWorkspaceModal } from "../../components/layout/sidebar/CreateWorkspaceModal";
import { useAuth } from "../../contexts/auth";
import {
  useDomain,
  useWorkspaceCollection,
  useProjectCollection,
  useMemberCollection,
  useInvitationCollection,
  useDomainHttp,
  type IDomainStore,
} from "../../contexts/domain";
import { useDomainActions } from "@shogo/shared-app/domain";
import { formatApiError } from "@shogo/shared-app/chat";
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { useWorkspaceExperience } from "../../hooks/useWorkspaceExperience";
import { usePooledWorkspaceCreation } from "../../hooks/usePooledWorkspaceCreation";
import { usePermissions, invalidatePermissions } from "../../hooks/usePermissions";
import { useInviteDialog } from "../../components/workspace/invite-dialog-context";
import { setActiveWorkspaceId } from "../../lib/workspace-store";
import {
  api,
  API_URL,
  type WorkspaceChildrenResponse,
  type WorkspaceDeletionPreview,
  type MemberInsight,
  type MemberInsightsData,
} from "../../lib/api";
import { useUsageLogCsvUrl } from "../../lib/usage-log-csv";
import {
  workspaceDeleteErrorMessage,
  workspaceErrorMessage,
} from "../../lib/workspace-errors";
import { useBillingData } from "@shogo/shared-app/hooks";
import {
  formatUsd,
  getWindowDisplays,
  getUsageLimitNotice,
  PLAN_PRICING,
} from "../../lib/billing-config";
import { usePlatformConfig } from "../../lib/platform-config";
import { openWebAppSession } from "../../lib/openWebAppSession";
import {
  canManageMemberRow,
  roleOptionsFor,
} from "../../lib/workspace-member-role";
import { usePostHogSafe } from "../../contexts/posthog";
import { EVENTS, trackEvent } from "../../lib/analytics";
import { SecuritySettingsPanel } from "../../components/security/SecuritySettingsPanel";
import { ComputerAndFilesPanel } from "../../components/settings/ComputerAndFilesPanel";
import { ComputeTab } from "../../components/settings/ComputeTab";
import { DiskSettings } from "../../components/settings/DiskSettings";
import { LocalCloudBillingTab } from "../../components/settings/LocalCloudBillingTab";
import { UpdatesTab } from "../../components/settings/UpdatesTab";
import { EnvironmentVersionTrigger } from "../../components/settings/EnvironmentPicker";
import { IntegrationsTab } from "../../components/settings/IntegrationsTab";
import { AutomationsTab } from "../../components/settings/AutomationsTab";
import { WorkspaceExportView } from "../../components/settings/WorkspaceExportView";
import { WorkspaceModelsTab } from "../../components/settings/WorkspaceModelsTab";
import { WorkspaceAccessTab } from "../../components/settings/WorkspaceAccessTab";
import { RemoteControlTab } from "../../components/settings/RemoteControlTab";
import { SetSpendLimitDialog } from "../../components/billing/SetSpendLimitDialog";
import { MemberUsageDetail } from "../../components/settings/MemberUsageDetail";
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
  isDesktopShell,
  isPhoneSettingsSurface,
  phoneSettingsTarget,
  resolveRequestedWorkspaceId,
} from "../../lib/phone-settings-route";
import {
  useToast,
  Toast,
  ToastTitle,
  ToastDescription,
} from "@/components/ui/toast";
import { invitationEvents } from "../../lib/invitation-events";
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
import { useNotificationPermission } from "../../lib/notifications/useNotificationPermission";
import type { NotificationPermissionState } from "../../lib/notifications/chat-notifier";
import { useRequireBiometricApproval } from "../../lib/approval-lock";
import { useDualPlan } from "../../lib/dual-plan-preference";
import { openExternalLink } from "../../lib/open-external-link";
import { isCloudWorkspace } from "../../lib/workspace-route";

const latestAnnouncedRelease = whatsNewCatalog.find((release) => release.announce);

const SETTINGS_ICON_MAP = {
  ArrowLeft: ArrowLeftIcon,
  Building2: Building2Icon,
  Users: UsersIcon,
  Boxes: BoxesIcon,
  Shield: ShieldIcon,
  ShieldCheck: ShieldCheckIcon,
  User: UserIcon,
  ExternalLink: ExternalLinkIcon,
  Trash2: Trash2Icon,
  ChevronDown: ChevronDownIcon,
  X: XGlyph,
  Search: SearchIcon,
  UserPlus: UserPlusIcon,
  Mail: MailIcon,
  MessageSquare: MessageSquareIcon,
  Zap: ZapIcon,
  CreditCard: CreditCardIcon,
  Cloud: CloudIcon,
  Server: ServerIcon,
  Plug: PlugIcon,
  Download: DownloadIcon,
  Monitor: MonitorIcon,
  Laptop: LaptopIcon,
  HardDrive: HardDriveIcon,
  Paintbrush: PaintbrushIcon,
  RefreshCw: RefreshCwIcon,
} as const;

function useSettingsIcons() {
  return useAccountSheetIcons(SETTINGS_ICON_MAP);
}

const SETTINGS_TAB_ICON_NAME: Record<TabId, keyof typeof SETTINGS_ICON_MAP> = {
  workspace: "Building2",
  people: "Users",
  chat: "MessageSquare",
  models: "Boxes",
  access: "ShieldCheck",
  integrations: "Plug",
  automations: "Zap",
  "remote-control": "Monitor",
  data: "Server",
  disk: "HardDrive",
  account: "User",
  security: "Shield",
  "computer-files": "Laptop",
  billing: "CreditCard",
  compute: "Server",
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
const IS_DESKTOP_CLIENT = isDesktopShell();

interface NavItem {
  id: TabId;
  label: string;
  icon: React.ElementType;
}

const MOBILE_NAV_ITEMS: NavItem[] = settingsNavItems([
  "workspace",
  "people",
  "chat",
  "models",
  "access",
  "integrations",
  "automations",
  "remote-control",
  "account",
  "appearance",
  ...(!HIDE_COMPUTE_PURCHASES_ON_IOS ? ["compute" as TabId] : []),
  "billing",
  ...(IS_DESKTOP_CLIENT ? ["updates" as TabId] : []),
]);

const LOCAL_NAV_ITEMS: NavItem[] = settingsNavItems([
  "workspace",
  "chat",
  "models",
  "access",
  "integrations",
  "automations",
  "remote-control",
  "account",
  "appearance",
  "security",
  ...(IS_DESKTOP_CLIENT ? ["computer-files" as TabId] : []),
  "billing",
  ...(IS_DESKTOP_CLIENT ? ["updates" as TabId] : []),
]);

function TabBar({
  activeTab,
  onTabChange,
  showBilling = true,
  localMode = false,
  teamChat = false,
}: {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  showBilling?: boolean;
  localMode?: boolean;
  /** Chat preferences only exist in a team workspace. */
  teamChat?: boolean;
}) {
  const icons = useSettingsIcons();
  const items = (showBilling && !localMode ? MOBILE_NAV_ITEMS : LOCAL_NAV_ITEMS).filter(
    (item) => item.id !== "chat" || teamChat,
  );
  return (
    <ScrollView
      horizontal
      testID="settings-legacy-tab-bar"
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
  userName,
  onExit,
  showBilling = true,
  localMode = false,
  teamChat = false,
  showPeople,
}: {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  userName: string;
  /** Omitted when the app sidebar is on screen: it already provides navigation and the workspace switcher. */
  onExit?: () => void;
  showBilling?: boolean;
  localMode?: boolean;
  /** Chat preferences only exist in a team workspace. */
  teamChat?: boolean;
  /**
   * Whether the People tab exists. Defaults to the cloud rule; a desktop
   * cloud workspace passes `true` so members are managed in the app, not in a
   * browser (SHO-454).
   */
  showPeople?: boolean;
}) {
  const { ArrowLeft } = useSettingsIcons();
  const tabItem = (id: TabId): SidebarItem => ({
    id,
    label: settingsTab(id).label,
  });

  const peopleVisible = showPeople ?? !(localMode || !showBilling);

  const workspaceItems: SidebarItem[] = [
    ...(peopleVisible ? [tabItem("people")] : []),
    ...(teamChat ? [tabItem("chat")] : []),
    tabItem("models"),
    tabItem("integrations"),
    tabItem("automations"),
    tabItem("disk"),
    tabItem("remote-control"),
    ...(showBilling
      ? [
          ...(!HIDE_COMPUTE_PURCHASES_ON_IOS ? [tabItem("compute")] : []),
          tabItem("billing"),
        ]
      : [tabItem("billing")]),
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
      {onExit ? (
        <>
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
        </>
      ) : null}

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
      {onExit ? (
        <WorkspaceAccountActions
          onSelectTab={onTabChange}
          showWorkspace={false}
          variant="sidebar"
        />
      ) : null}
    </ScrollView>
  );
}

// ============================================================================
// WORKSPACE SETTINGS TAB
// ============================================================================

/** Human byte size for the delete dialog's "what disappears" list. */
function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

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
  const toast = useToast();

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
  const [isLeaving, setIsLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deletePreview, setDeletePreview] = useState<WorkspaceDeletionPreview | null>(null);
  const [deletePreviewError, setDeletePreviewError] = useState<string | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const originalName = currentWorkspace?.name || "";
  const hasChanges = name !== originalName;
  const isValid = name.trim().length > 0 && name.length <= 60;

  const membersAll = Array.isArray(members.all) ? members.all : [];
  const workspaceMembers = currentWorkspace?.id
    ? membersAll.filter(
        (m: any) => m.workspaceId === currentWorkspace.id && !m.projectId
      )
    : [];
  const { can, workspaceRole } = usePermissions({
    workspaceId: currentWorkspace?.id,
  });
  const isOwner = workspaceRole === "owner";
  const canRename = can("workspace:update");
  const canManageWorkspace = can("workspace.settings:manage");
  const canDeleteWorkspace = can("workspace:delete");

  // `kind` (not a slug/name heuristic) is the source of truth — a team
  // workspace named e.g. "My Personal Brand" must stay deletable.
  const isPersonalWorkspace = currentWorkspace?.kind === "personal";

  const wsAll = Array.isArray(workspaces.all) ? workspaces.all : [];
  const canDelete =
    canDeleteWorkspace && wsAll.length > 1 && !isPersonalWorkspace;
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
    if (!hasChanges || !isValid || !canRename || !currentWorkspace?.id) return;
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

  const openDeleteDialog = async () => {
    const workspaceId = currentWorkspace?.id;
    setDeleteConfirmText("");
    setDeleteError(null);
    setDeletePreview(null);
    setDeletePreviewError(null);
    setIsDeleteDialogOpen(true);
    if (!workspaceId || !http) return;
    setIsLoadingPreview(true);
    try {
      setDeletePreview(await api.getWorkspaceDeletionPreview(http, workspaceId));
    } catch (error: any) {
      setDeletePreviewError(
        workspaceDeleteErrorMessage(error, "Could not list this workspace's files.")
      );
    } finally {
      setIsLoadingPreview(false);
    }
  };

  const handleDeleteWorkspace = async () => {
    if (!currentWorkspace?.id || !isDeleteConfirmed) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const workspaceId = currentWorkspace.id;
      // Local mode wipes the files too, so it goes through the dedicated route
      // (which reports what it removed); the cloud path keeps the collection's
      // optimistic delete.
      let result: { removedDirs: string[]; warnings: string[] } = {
        removedDirs: [],
        warnings: [],
      };
      if (localMode && http) {
        result = await api.deleteWorkspace(http, workspaceId);
      } else {
        await actions.deleteWorkspace(workspaceId);
      }
      setIsDeleteDialogOpen(false);
      await workspaces.loadAll();
      const remaining = (Array.isArray(workspaces.all) ? workspaces.all : []).filter(
        (ws: any) => ws.id !== workspaceId
      );
      if (remaining.length > 0) setActiveWorkspaceId(remaining[0].id);
      // A delete takes the workspace's runtime with it, so the shell has to move
      // to a workspace that still exists — same destination as the cloud path.
      // The file report can't live on this screen (it unmounts), so it goes out
      // as a toast that survives the navigation.
      if (localMode && result.removedDirs.length + result.warnings.length > 0) {
        const removed = result.removedDirs.length;
        const hasWarnings = result.warnings.length > 0;
        toast.show({
          placement: "top",
          duration: 6000,
          render: ({ id }: { id: string }) => (
            <Toast nativeID={id} variant="solid" action={hasWarnings ? "warning" : "success"}>
              <ToastTitle>
                {hasWarnings ? "Workspace deleted with warnings" : "Workspace deleted"}
              </ToastTitle>
              <ToastDescription>
                {`${removed} ${removed === 1 ? "directory" : "directories"} removed` +
                  (result.removedDirs[0] ? ` (${result.removedDirs[0]})` : "") +
                  (hasWarnings ? ` — ${result.warnings[0]}` : "")}
              </ToastDescription>
            </Toast>
          ),
        });
      }
      router.replace("/(app)");
    } catch (error) {
      console.error("Failed to delete workspace:", error);
      setDeleteError(
        workspaceDeleteErrorMessage(error, "Could not delete the workspace.")
      );
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
                      disabled={!canRename}
                      onChangeText={(t) => {
                        setName(t);
                        setSaveStatus("idle");
                      }}
                    />
                  </View>
                  <Button
                    onPress={handleSave}
                    disabled={!canRename || !hasChanges || !isValid || isSaving}
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
                disabled={!canRename}
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
                  disabled={!canRename || !hasChanges || !isValid || isSaving}
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
              checked={trainingDataEnabled}
              onCheckedChange={(enabled) => void handleTrainingDataChange(enabled)}
              disabled={!canManageWorkspace}
            />
          </View>
        </CardContent>
      </Card>

      {!localMode && (
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
              </View>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  wsAll.length <= 1 ||
                  (isOwner &&
                    !workspaceMembers.some(
                      (m: any) => m.role === "owner" && m.userId !== user?.id
                    ))
                }
                onPress={() => setIsLeaveDialogOpen(true)}
              >
                Leave workspace
              </Button>
            </View>
          </CardContent>
        </Card>
      )}

      {/* Also shown in local mode: a desktop user can now have several
          workspaces, and deleting one is the only way back out. */}
      {canDeleteWorkspace && (
        <Card>
          <CardContent className="p-0">
            <View className="px-6 py-5 flex-row items-center justify-between">
              <View className="flex-1 mr-4">
                <Text className="text-base font-semibold text-destructive">
                  Delete workspace
                </Text>
                <Text className="text-sm text-muted-foreground mt-0.5">
                  {canDelete
                    ? localMode
                      ? "Permanently delete this workspace, its projects and their files."
                      : "Permanently delete this workspace and all its data."
                    : isPersonalWorkspace
                    ? "Your personal workspace cannot be deleted."
                    : "You cannot delete your only workspace."}
                </Text>
              </View>
              <Button
                variant="destructive"
                size="sm"
                accessibilityLabel="Delete workspace"
                disabled={!canDelete}
                onPress={() => void openDeleteDialog()}
              >
                Delete
              </Button>
            </View>
          </CardContent>
        </Card>
      )}

      {/* Leave Workspace Confirmation Modal */}
      <Modal
        visible={isLeaveDialogOpen}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!isLeaving) {
            setIsLeaveDialogOpen(false);
            setLeaveError(null);
          }
        }}
      >
        <Pressable
          className="flex-1 bg-black/50 justify-center items-center px-6"
          onPress={() => {
            if (!isLeaving) {
              setIsLeaveDialogOpen(false);
              setLeaveError(null);
            }
          }}
        >
          <Pressable className="bg-background rounded-xl p-6 w-full max-w-sm gap-4">
            <View className="flex-row items-center justify-between">
              <Text className="text-lg font-semibold text-foreground">
                Leave workspace
              </Text>
              <Pressable
                onPress={() => {
                  if (!isLeaving) {
                    setIsLeaveDialogOpen(false);
                    setLeaveError(null);
                  }
                }}
                className="p-1"
              >
                <X size={20} className="text-muted-foreground" />
              </Pressable>
            </View>
            <Text className="text-sm text-muted-foreground">
              Are you sure you want to leave "{currentWorkspace?.name}"? You
              will lose access to all projects and data in this workspace.
            </Text>
            {leaveError && (
              <Text className="text-sm text-destructive">{leaveError}</Text>
            )}
            <View className="flex-row gap-2 justify-end">
              <Button
                variant="outline"
                size="sm"
                onPress={() => {
                  setIsLeaveDialogOpen(false);
                  setLeaveError(null);
                }}
                disabled={isLeaving}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={isLeaving}
                onPress={async () => {
                  setIsLeaving(true);
                  setLeaveError(null);
                  try {
                    const wsId = currentWorkspace?.id;
                    if (!wsId || !http) {
                      setLeaveError("Missing workspace information.");
                      setIsLeaving(false);
                      return;
                    }
                    await api.leaveWorkspace(http, wsId);
                    await workspaces.loadAll();
                    const remaining = Array.isArray(workspaces.all)
                      ? workspaces.all
                      : [];
                    if (remaining.length > 0) {
                      setActiveWorkspaceId((remaining[0] as any).id);
                    }
                    setIsLeaveDialogOpen(false);
                    setLeaveError(null);
                    router.replace("/(app)/projects");
                  } catch (error: any) {
                    console.error(
                      "[Settings] Failed to leave workspace:",
                      error
                    );
                    const msg =
                      error?.details?.error?.message ||
                      error?.message ||
                      "Failed to leave workspace.";
                    setLeaveError(msg);
                    setIsLeaving(false);
                  }
                }}
              >
                {isLeaving ? "Leaving..." : "Leave workspace"}
              </Button>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

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
              workspace "{currentWorkspace?.name}"
              {localMode ? " and the project files listed below." : "."}
            </Text>
            {isLoadingPreview && (
              <Text className="text-xs text-muted-foreground">
                Checking what will be removed…
              </Text>
            )}
            {deletePreviewError && (
              <Text className="text-xs text-destructive">{deletePreviewError}</Text>
            )}
            {deletePreview && (
              <View className="gap-1">
                {deletePreview.projects.map((project) => (
                  <View key={project.id} className="flex-row items-start justify-between gap-2">
                    <Text className="flex-1 text-xs text-muted-foreground" numberOfLines={2}>
                      {project.path ?? project.folderPath ?? project.name}
                    </Text>
                    <Text className="text-xs text-muted-foreground">
                      {project.folderLinked
                        ? "your folder, kept"
                        : project.sizeBytes === null
                        ? ""
                        : formatBytes(project.sizeBytes)}
                    </Text>
                  </View>
                ))}
                {deletePreview.removedDirs.length > 0 && (
                  <Text className="text-xs text-muted-foreground">
                    {deletePreview.removedDirs.length}{" "}
                    {deletePreview.removedDirs.length === 1 ? "directory" : "directories"}
                    {deletePreview.totalBytes !== null
                      ? `, ${formatBytes(deletePreview.totalBytes)}`
                      : ""}
                    {" · "}
                    {deletePreview.channelCount} channels, {deletePreview.boardCount} boards,{" "}
                    {deletePreview.chatCount} chats
                  </Text>
                )}
                {deletePreview.projects.some((project) => project.folderLinked) && (
                  <Text className="text-xs text-muted-foreground">
                    Folder-linked projects keep their own files on disk.
                  </Text>
                )}
              </View>
            )}
            <Text className="text-sm text-muted-foreground">
              Please type "{deleteConfirmRequired}" to confirm.
            </Text>
            <Input
              value={deleteConfirmText}
              onChangeText={setDeleteConfirmText}
              placeholder={`Type "${deleteConfirmRequired}" to confirm`}
            />
            {deleteError && (
              <Text className="text-sm text-destructive">{deleteError}</Text>
            )}
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
                accessibilityLabel="Confirm delete workspace"
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

function notificationPermissionCopy(
  state: NotificationPermissionState | null
): { status: string; action: "request" | "settings" | null } {
  switch (state) {
    case "granted":
      return { status: "On for this device.", action: null };
    case "prompt":
      return {
        status: "Not turned on yet. Shogo can't show any alerts on this device.",
        action: "request",
      };
    case "denied":
      return Platform.OS === "web"
        ? {
            status:
              "Blocked by your browser. Allow notifications for this site in the browser's site settings.",
            action: null,
          }
        : {
            status: "Turned off in Settings. Shogo can't show any alerts on this device.",
            action: "settings",
          };
    case "unsupported":
      return { status: "This browser or device can't show notifications.", action: null };
    default:
      return { status: "Checking…", action: null };
  }
}

function NotificationsCard() {
  const [notifyOnTurn, setNotifyOnTurn] = useNotifyOnTurnCompletePref();
  const [requireBiometric, setRequireBiometric] = useRequireBiometricApproval();
  const permission = useNotificationPermission();
  const copy = notificationPermissionCopy(permission.state);
  return (
    <Card>
      <CardContent className="p-0">
        <View className="px-6 py-5 flex-row items-center justify-between">
          <View className="flex-1 mr-4">
            <Text className="text-sm font-semibold text-foreground">
              Notifications on this device
            </Text>
            <Text className="text-sm text-muted-foreground mt-0.5">
              {copy.status}
            </Text>
          </View>
          {copy.action === "request" ? (
            <Button size="sm" onPress={() => void permission.request()}>
              Turn on
            </Button>
          ) : copy.action === "settings" ? (
            <Button size="sm" variant="outline" onPress={permission.openSettings}>
              Open Settings
            </Button>
          ) : null}
        </View>
        <View className="px-6 py-5 flex-row items-center justify-between border-t border-border">
          <View className="flex-1 mr-4">
            <Text className="text-sm font-semibold text-foreground">
              Notify when a reply is ready
            </Text>
            <Text className="text-sm text-muted-foreground mt-0.5">
              Send a system notification when a chat turn finishes and you
              aren't looking at that chat. Applies on desktop, web, and mobile.
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
              When on, every plan the agent writes also gets a stakeholder
              summary alongside the technical body. You can flip between the Technical
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
// PEOPLE TAB — Lovable-style workspace member management
// ============================================================================

type PeopleSubTab = "all" | "invitations";

const ROLE_DISPLAY: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Editor",
  viewer: "Viewer",
};

const ROLE_COLORS: Record<string, string> = {
  owner: "bg-amber-500",
  admin: "bg-blue-500",
  member: "bg-emerald-500",
  viewer: "bg-slate-400",
};

type SortField =
  | "name"
  | "role"
  | "included"
  | "free"
  | "onDemand"
  | "plans"
  | "lines"
  | "tokens"
  | "model";
type SortDir = "asc" | "desc";
type MemberUsagePeriod = "7d" | "30d" | "90d";

function formatUsdLabel(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

function formatCountLabel(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value));
}

/** Renders a member's included usage as their share of the team total (no dollar pool). */
function formatSharePct(value: number, total: number): string {
  if (total <= 0 || value <= 0) return "0%";
  const pct = (value / total) * 100;
  if (pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

const PeopleTab = observer(function PeopleTab() {
  const { X, ChevronDown, Download, Search, UserPlus, Users, Mail } =
    useSettingsIcons();
  const { width } = useWindowDimensions();
  const isMobilePeopleLayout = width < SETTINGS_WIDE_BREAKPOINT;

  const { user } = useAuth();
  const workspaces = useWorkspaceCollection();
  const members = useMemberCollection();
  const invitations = useInvitationCollection();
  const actions = useDomainActions();
  const http = useDomainHttp();
  const currentWorkspace = useActiveWorkspace();
  const toast = useToast();
  const { can, canInvite, workspaceRole, invitePolicy } = usePermissions({
    workspaceId: currentWorkspace?.id,
  });
  // Inviting is the shared dialog, never a second modal (SHO-454).
  const inviteDialog = useInviteDialog();
  // Workspace analytics are owner/admin only; a member's People tab must not
  // fire the two workspace-wide usage reads (they would only 403).
  const canViewMemberAnalytics = can("workspace.analytics:read");

  const [subTab, setSubTab] = useState<PeopleSubTab>("all");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [showRoleFilter, setShowRoleFilter] = useState(false);
  // Who may invite (SHO-454). Owners and admins can restrict it to admins.
  const canManageSettings = can("workspace.settings:manage");
  const [policy, setPolicy] = useState<"members" | "admins">(invitePolicy ?? "members");
  const [savingPolicy, setSavingPolicy] = useState(false);
  useEffect(() => {
    if (invitePolicy) setPolicy(invitePolicy);
  }, [invitePolicy]);
  const changePolicy = useCallback(
    async (next: "members" | "admins") => {
      if (!currentWorkspace?.id || !http || next === policy) return;
      const previous = policy;
      setPolicy(next);
      setSavingPolicy(true);
      try {
        await api.setWorkspaceInvitePolicy(http, currentWorkspace.id, next);
        invalidatePermissions({ workspaceId: currentWorkspace.id });
      } catch (err) {
        setPolicy(previous);
        toast.show({
          placement: "top",
          duration: 4000,
          render: ({ id }: { id: string }) => (
            <Toast nativeID={id} variant="outline" action="error">
              <ToastTitle>Could not change who can invite</ToastTitle>
              <ToastDescription>{formatApiError(err)}</ToastDescription>
            </Toast>
          ),
        });
      } finally {
        setSavingPolicy(false);
      }
    },
    [currentWorkspace?.id, http, policy, toast],
  );
  const [sortField, setSortField] = useState<SortField>("onDemand");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [isLoading, setIsLoading] = useState(true);
  const [menuState, setMenuState] = useState<{
    memberId: string;
    view: "actions" | "roles";
  } | null>(null);
  const [userMap, setUserMap] = useState<
    Record<string, { name: string; email: string }>
  >({});

  const [resolvedWs, setResolvedWs] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [memberUsage, setMemberUsage] = useState<{
    monthly: Record<string, number>;
    total: Record<string, number>;
    included: Record<string, number>;
    free: Record<string, number>;
    onDemand: Record<string, number>;
  }>({ monthly: {}, total: {}, included: {}, free: {}, onDemand: {} });
  const [memberUsagePeriod, setMemberUsagePeriod] =
    useState<MemberUsagePeriod>("30d");
  const [memberInsights, setMemberInsights] = useState<MemberInsightsData>({
    rows: [],
    total: 0,
  });
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [selectedMemberInsight, setSelectedMemberInsight] =
    useState<MemberInsight | null>(null);
  const [isLoadingMemberInsight, setIsLoadingMemberInsight] = useState(false);

  const loadPeopleData = useCallback(async () => {
    if (!currentWorkspace?.id) {
      if ((Array.isArray(workspaces.all) ? workspaces.all : []).length === 0) {
        try {
          await workspaces.loadAll({});
        } catch {}
      }
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const ws = currentWorkspace;
      setResolvedWs({ id: ws.id, name: ws.name || "Workspace" });

      await members.loadAll({ workspaceId: ws.id });
      await invitations.loadAll({ workspaceId: ws.id });

      if (http) {
        try {
          const rawItems = await api.getWorkspaceMembers(http, ws.id);
          const items = Array.isArray(rawItems) ? rawItems : [];
          const map: Record<string, { name: string; email: string }> = {};
          for (const item of items) {
            if (item.user && typeof item.user === "object" && item.user.id) {
              map[item.user.id] = {
                name: item.user.name || "",
                email: item.user.email || "",
              };
            }
          }
          setUserMap(map);
        } catch {}

        if (canViewMemberAnalytics) {
          try {
            const usage = await api.getMemberUsageStats(http, ws.id, {
              period: memberUsagePeriod,
            });
            setMemberUsage(usage);
          } catch {}

          try {
            const insights = await api.getMemberInsights(http, ws.id, {
              period: memberUsagePeriod,
            });
            setMemberInsights(insights);
          } catch {
            setMemberInsights({ rows: [], total: 0 });
          }
        }
      }
    } catch {}
    setIsLoading(false);
  }, [
    workspaces,
    members,
    invitations,
    http,
    currentWorkspace?.id,
    memberUsagePeriod,
    canViewMemberAnalytics,
  ]);

  useEffect(() => {
    loadPeopleData();
  }, [loadPeopleData]);

  useEffect(() => invitationEvents.subscribe(loadPeopleData), [loadPeopleData]);

  const ROLE_PRIORITY: Record<string, number> = {
    owner: 0,
    admin: 1,
    member: 2,
    viewer: 3,
  };

  const workspaceMembers = useMemo(() => {
    if (!currentWorkspace?.id) return [];
    const allMembers = Array.isArray(members.all) ? members.all : [];
    const raw = allMembers.filter(
      (m: any) => m.workspaceId === currentWorkspace.id && !m.projectId
    );
    const byUser = new Map<string, any>();
    for (const m of raw) {
      const existing = byUser.get(m.userId);
      if (
        !existing ||
        (ROLE_PRIORITY[m.role] ?? 9) < (ROLE_PRIORITY[existing.role] ?? 9)
      ) {
        byUser.set(m.userId, m);
      }
    }
    return Array.from(byUser.values());
  }, [currentWorkspace?.id, members.all]);
  const memberInsightMap = useMemo(
    () => new Map(memberInsights.rows.map((row) => [row.userId, row])),
    [memberInsights.rows]
  );
  const allInvitations = Array.isArray(invitations.all) ? invitations.all : [];
  const sentInvitations = currentWorkspace?.id
    ? allInvitations.filter(
        (i: any) =>
          i.workspaceId === currentWorkspace.id && i.status !== "cancelled"
      )
    : [];

  const filteredMembers = useMemo(() => {
    let result = [...workspaceMembers];
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((m: any) => {
        const u = userMap[m.userId];
        return (
          (u?.name || "").toLowerCase().includes(q) ||
          (u?.email || "").toLowerCase().includes(q) ||
          (m.userId || "").toLowerCase().includes(q)
        );
      });
    }
    if (roleFilter !== "all") {
      result = result.filter((m: any) => m.role === roleFilter);
    }
    result.sort((a: any, b: any) => {
      let cmp = 0;
      if (sortField === "name")
        cmp = (a.userId || "").localeCompare(b.userId || "");
      else if (sortField === "role")
        cmp = (a.role || "").localeCompare(b.role || "");
      else if (sortField === "included")
        cmp =
          (memberUsage.included[a.userId] ?? 0) -
          (memberUsage.included[b.userId] ?? 0);
      else if (sortField === "free")
        cmp =
          (memberUsage.free[a.userId] ?? 0) - (memberUsage.free[b.userId] ?? 0);
      else if (sortField === "onDemand")
        cmp =
          (memberUsage.onDemand[a.userId] ?? 0) -
          (memberUsage.onDemand[b.userId] ?? 0);
      else if (sortField === "plans")
        cmp =
          (memberInsightMap.get(a.userId)?.plansCreated ?? 0) -
          (memberInsightMap.get(b.userId)?.plansCreated ?? 0);
      else if (sortField === "lines")
        cmp =
          (memberInsightMap.get(a.userId)?.linesAdded ?? 0) -
          (memberInsightMap.get(b.userId)?.linesAdded ?? 0);
      else if (sortField === "tokens")
        cmp =
          (memberInsightMap.get(a.userId)?.totalTokens ?? 0) -
          (memberInsightMap.get(b.userId)?.totalTokens ?? 0);
      else if (sortField === "model") {
        const aModel = memberInsightMap.get(a.userId)?.models[0]?.model ?? "";
        const bModel = memberInsightMap.get(b.userId)?.models[0]?.model ?? "";
        cmp = aModel.localeCompare(bModel);
      }
      return sortDir === "desc" ? -cmp : cmp;
    });
    return result;
  }, [
    workspaceMembers,
    search,
    roleFilter,
    sortField,
    sortDir,
    memberUsage,
    memberInsightMap,
  ]);

  const includedTotalAll = useMemo(
    () =>
      Object.values(memberUsage.included).reduce((sum, v) => sum + (v || 0), 0),
    [memberUsage.included]
  );

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const canManageMembers = can("workspace.members:manage");
  const isOwner = workspaceRole === "owner";
  const canManageMember = (member: { role?: string; userId?: string }) =>
    canManageMemberRow(
      { canManageMembers, isOwner, isSelf: member.userId === user?.id },
      member.role
    );

  const projects = useProjectCollection();
  const projectGuests = useMemo(() => {
    if (!currentWorkspace?.id) return [];
    const allMembers = Array.isArray(members.all) ? members.all : [];
    const allProjects = Array.isArray(projects.all) ? projects.all : [];
    type GuestEntry = {
      userId: string;
      grants: { memberId: string; projectName: string; role: string }[];
    };
    const byUser = new Map<string, GuestEntry>();
    for (const m of allMembers as any[]) {
      if (m.workspaceId !== currentWorkspace.id || !m.projectId) continue;
      const project = allProjects.find((p: any) => p.id === m.projectId);
      const entry: GuestEntry = byUser.get(m.userId) ?? {
        userId: m.userId,
        grants: [],
      };
      entry.grants.push({
        memberId: m.id,
        projectName: project?.name || "Restricted project",
        role: m.role === "owner" ? "admin" : m.role,
      });
      byUser.set(m.userId, entry);
    }
    const workspaceUserIds = new Set(workspaceMembers.map((m: any) => m.userId));
    return Array.from(byUser.values()).filter(
      (g) => !workspaceUserIds.has(g.userId)
    );
  }, [currentWorkspace?.id, members.all, projects.all, workspaceMembers]);

  const handleOpenMemberUsage = useCallback(
    async (memberUserId: string) => {
      setSelectedMemberId(memberUserId);
      setSelectedMemberInsight(memberInsightMap.get(memberUserId) ?? null);
      if (!http || !currentWorkspace?.id) return;

      setIsLoadingMemberInsight(true);
      try {
        const data = await api.getMemberInsights(http, currentWorkspace.id, {
          period: memberUsagePeriod,
          userId: memberUserId,
        });
        setSelectedMemberInsight(data.rows[0] ?? null);
      } catch {
        // Keep the summary row visible if the detail request fails.
      } finally {
        setIsLoadingMemberInsight(false);
      }
    },
    [http, currentWorkspace?.id, memberUsagePeriod, memberInsightMap]
  );

  const handleMemberUsagePeriodChange = useCallback(
    async (period: MemberUsagePeriod) => {
      setMemberUsagePeriod(period);
      if (!selectedMemberId || !http || !currentWorkspace?.id) return;
      setIsLoadingMemberInsight(true);
      try {
        const data = await api.getMemberInsights(http, currentWorkspace.id, {
          period,
          userId: selectedMemberId,
        });
        setSelectedMemberInsight(data.rows[0] ?? null);
      } catch {
        // Keep the current detail view if the refresh fails.
      } finally {
        setIsLoadingMemberInsight(false);
      }
    },
    [http, currentWorkspace?.id, selectedMemberId]
  );

  const handleChangeRole = async (
    memberId: string,
    newRole: "owner" | "admin" | "member" | "viewer"
  ) => {
    try {
      await actions.updateMemberRole(memberId, newRole, user?.id || "");
      setMenuState(null);
      await loadPeopleData();
    } catch (err) {
      setMenuState(null);
      toast.show({
        placement: "top",
        duration: 5000,
        render: ({ id }: { id: string }) => (
          <Toast nativeID={id} variant="outline" action="error">
            <ToastTitle>Could not change the role</ToastTitle>
            <ToastDescription>
              {err instanceof Error && err.message
                ? err.message
                : "Please try again."}
            </ToastDescription>
          </Toast>
        ),
      });
    }
  };

  const handleRemoveMember = useCallback(
    async (memberId: string) => {
      const confirmed =
        Platform.OS === "web"
          ? window.confirm("Are you sure you want to remove this member?")
          : true;
      if (!confirmed) {
        setMenuState(null);
        return;
      }
      try {
        setMenuState(null);
        await actions.removeMember(memberId, user?.id || "");
        await loadPeopleData();
      } catch {
        toast.show({
          placement: "top",
          duration: 5000,
          render: ({ id }: { id: string }) => (
            <Toast nativeID={id} variant="outline" action="error">
              <ToastTitle>Failed to remove member</ToastTitle>
              <ToastDescription>
                You may not have permission. Please try again.
              </ToastDescription>
            </Toast>
          ),
        });
      }
    },
    [actions, user?.id, loadPeopleData, toast]
  );

  const [revokeInvitationTarget, setRevokeInvitationTarget] = useState<{
    id: string;
    email: string;
  } | null>(null);
  const [isRevokingInvitation, setIsRevokingInvitation] = useState(false);

  const confirmRevokeInvitation = useCallback(async () => {
    if (!revokeInvitationTarget) return;
    setIsRevokingInvitation(true);
    try {
      await actions.cancelInvitation(revokeInvitationTarget.id);
      setRevokeInvitationTarget(null);
      await loadPeopleData();
    } catch {
    } finally {
      setIsRevokingInvitation(false);
    }
  }, [actions, loadPeopleData, revokeInvitationTarget]);

  const builderCount = workspaceMembers.length;
  const currentMonth = new Date().toLocaleString("default", { month: "short" });

  const SUB_TABS: { id: PeopleSubTab; label: string }[] = [
    { id: "all", label: "All" },
    { id: "invitations", label: "Invitations" },
  ];

  const SortArrow = ({ field }: { field: SortField }) => (
    <View className="ml-1">
      <Text
        className={cn(
          "text-[8px]",
          sortField === field && sortDir === "asc"
            ? "text-foreground"
            : "text-muted-foreground/40"
        )}
      >
        ▲
      </Text>
      <Text
        className={cn(
          "text-[8px] -mt-1",
          sortField === field && sortDir === "desc"
            ? "text-foreground"
            : "text-muted-foreground/40"
        )}
      >
        ▼
      </Text>
    </View>
  );

  /** Keeps header/body aligned: name flexes separately so usage columns stay evenly spaced, not shoved to the edge. */
  const peopleNameCol = cn(
    "flex-1 min-w-[220px]",
    !isMobilePeopleLayout && "max-w-md"
  );
  const peopleMetricsRow = "flex-row items-center gap-x-5 shrink-0";
  const colRole = "w-[104px]";
  const colUsage = "w-[120px]";
  const colInsight = "w-[96px]";
  const colActions = "w-11 items-center justify-center pr-1";

  const memberListTable = (
    <>
      <View className="flex-row items-center justify-between gap-4 px-4 py-2.5 pr-5 border-b border-border bg-muted/30">
        <Pressable
          onPress={() => handleSort("name")}
          className={cn("flex-row items-center", peopleNameCol)}
        >
          <Text className="text-xs font-medium text-muted-foreground">
            Member
          </Text>
          <SortArrow field="name" />
        </Pressable>
        <View className={peopleMetricsRow}>
          <Pressable
            onPress={() => handleSort("role")}
            className={cn("flex-row items-center", colRole)}
          >
            <Text className="text-xs font-medium text-muted-foreground">
              Role
            </Text>
            <SortArrow field="role" />
          </Pressable>
          <Pressable
            onPress={() => handleSort("included")}
            className={cn("flex-row items-center justify-end", colUsage)}
          >
            <Text className="text-xs font-medium text-muted-foreground text-right">
              Included Usage
            </Text>
            <SortArrow field="included" />
          </Pressable>
          <Pressable
            onPress={() => handleSort("free")}
            className={cn("flex-row items-center justify-end", colUsage)}
          >
            <Text className="text-xs font-medium text-muted-foreground text-right">
              Free Usage
            </Text>
            <SortArrow field="free" />
          </Pressable>
          <Pressable
            onPress={() => handleSort("onDemand")}
            className={cn("flex-row items-center justify-end", colUsage)}
          >
            <Text className="text-xs font-medium text-muted-foreground text-right">
              On-Demand Usage
            </Text>
            <SortArrow field="onDemand" />
          </Pressable>
          <Pressable
            onPress={() => handleSort("plans")}
            className={cn("flex-row items-center justify-end", colInsight)}
          >
            <Text className="text-xs font-medium text-muted-foreground text-right">
              Plans
            </Text>
            <SortArrow field="plans" />
          </Pressable>
          <Pressable
            onPress={() => handleSort("lines")}
            className={cn("flex-row items-center justify-end", colInsight)}
          >
            <Text className="text-xs font-medium text-muted-foreground text-right">
              Lines
            </Text>
            <SortArrow field="lines" />
          </Pressable>
          <Pressable
            onPress={() => handleSort("tokens")}
            className={cn("flex-row items-center justify-end", colInsight)}
          >
            <Text className="text-xs font-medium text-muted-foreground text-right">
              Tokens
            </Text>
            <SortArrow field="tokens" />
          </Pressable>
          <Pressable
            onPress={() => handleSort("model")}
            className={cn("flex-row items-center justify-end", colInsight)}
          >
            <Text className="text-xs font-medium text-muted-foreground text-right">
              Top model
            </Text>
            <SortArrow field="model" />
          </Pressable>
          <View className={colActions} />
        </View>
      </View>

      {filteredMembers.map((member: any) => {
        const isCurrentUser = member.userId === user?.id;
        // The workspace usage columns come from the admin-only endpoints, so a
        // member sees a dash for every row — including their own, whose real
        // numbers live in Profile → Usage (`/me/analytics/*`). Rendering "0%"
        // from an unfetched table would be a wrong number, not a hidden one.
        const canSeeInsight = canViewMemberAnalytics;
        const canEditMember = canManageMember(member);
        const insight = memberInsightMap.get(member.userId);
        const avatarColor = ROLE_COLORS[member.role] || "bg-primary";
        const resolved = userMap[member.userId];
        const mName = isCurrentUser
          ? user?.name || user?.email
          : resolved?.name || resolved?.email || member.userId;
        const mEmail = isCurrentUser
          ? user?.email
          : resolved?.email || member.userId;
        const initial = (mName || "M")[0]?.toUpperCase();
        return (
          <View
            key={member.id}
            className="flex-row items-center justify-between gap-4 px-4 py-3 pr-5 border-b border-border overflow-visible"
          >
            <Pressable
              onPress={
                canSeeInsight
                  ? () => void handleOpenMemberUsage(member.userId)
                  : undefined
              }
              accessibilityRole="button"
              accessibilityLabel={`View usage for ${mName}`}
              className={cn("flex-row items-center gap-3", peopleNameCol)}
            >
              <View
                className={cn(
                  "h-8 w-8 rounded-full items-center justify-center shrink-0",
                  avatarColor
                )}
              >
                <Text className="text-xs font-semibold text-white">
                  {initial}
                </Text>
              </View>
              <View className="min-w-0 flex-1">
                <View className="flex-row items-center gap-1 flex-wrap">
                  <Text
                    className="text-sm font-medium text-foreground"
                    numberOfLines={2}
                  >
                    {mName}
                  </Text>
                  {isCurrentUser && (
                    <Text className="text-sm text-muted-foreground">(you)</Text>
                  )}
                </View>
                <Text
                  className="text-xs text-muted-foreground"
                  numberOfLines={2}
                >
                  {mEmail}
                </Text>
              </View>
            </Pressable>

            <View className={peopleMetricsRow}>
              <View className={colRole}>
                {canEditMember ? (
                  <Pressable
                    onPress={() =>
                      setMenuState(
                        menuState?.memberId === member.id &&
                          menuState?.view === "roles"
                          ? null
                          : { memberId: member.id, view: "roles" }
                      )
                    }
                    className="flex-row items-center gap-1"
                  >
                    <Text className="text-sm text-foreground capitalize">
                      {ROLE_DISPLAY[member.role] || member.role}
                    </Text>
                    <ChevronDown size={12} className="text-muted-foreground" />
                  </Pressable>
                ) : (
                  <Text className="text-sm text-foreground capitalize">
                    {ROLE_DISPLAY[member.role] || member.role}
                  </Text>
                )}
              </View>

              <View className={cn(colUsage, "items-end")}>
                <Text className="text-sm text-foreground text-right tabular-nums">
                  {canSeeInsight
                    ? formatSharePct(
                        memberUsage.included[member.userId] ?? 0,
                        includedTotalAll
                      )
                    : "—"}
                </Text>
              </View>

              <View className={cn(colUsage, "items-end")}>
                <Text className="text-sm text-foreground text-right tabular-nums">
                  {canSeeInsight
                    ? formatUsdLabel(memberUsage.free[member.userId] ?? 0)
                    : "—"}
                </Text>
              </View>

              <View className={cn(colUsage, "items-end")}>
                <Text className="text-sm text-foreground text-right tabular-nums">
                  {canSeeInsight
                    ? formatUsdLabel(memberUsage.onDemand[member.userId] ?? 0)
                    : "—"}
                </Text>
              </View>

              <View className={cn(colInsight, "items-end")}>
                <Text className="text-sm text-foreground text-right tabular-nums">
                  {canSeeInsight ? formatCountLabel(insight?.plansCreated ?? 0) : "—"}
                </Text>
              </View>

              <View className={cn(colInsight, "items-end")}>
                <Text className="text-sm text-foreground text-right tabular-nums">
                  {canSeeInsight
                    ? `+${formatCountLabel(insight?.linesAdded ?? 0)}`
                    : "—"}
                </Text>
              </View>

              <View className={cn(colInsight, "items-end")}>
                <Text className="text-sm text-foreground text-right tabular-nums">
                  {canSeeInsight
                    ? formatCountLabel(insight?.totalTokens ?? 0)
                    : "—"}
                </Text>
              </View>

              <View className={cn(colInsight, "items-end")}>
                <Text
                  className="text-sm text-foreground text-right"
                  numberOfLines={1}
                >
                  {canSeeInsight ? insight?.models[0]?.model || "—" : "—"}
                </Text>
              </View>

              <View className={colActions}>
                {canEditMember ? (
                  <Pressable
                    onPress={() =>
                      setMenuState({ memberId: member.id, view: "actions" })
                    }
                    className="items-center justify-center min-w-[44px] min-h-[44px] -mr-1"
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text className="text-muted-foreground">···</Text>
                  </Pressable>
                ) : (
                  <View className="items-center justify-center min-w-[44px] min-h-[44px] -mr-1">
                    <Text className="text-muted-foreground/30">···</Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        );
      })}

      <View className="px-4 py-2.5">
        <Text className="text-xs text-muted-foreground">
          Showing 1-{filteredMembers.length} of {filteredMembers.length}
        </Text>
      </View>
    </>
  );

  const sentInvitationListTable = (
    <>
      <View className="flex-row items-center px-4 py-2.5 border-b border-border bg-muted/30">
        <View
          className={cn(
            "flex-[2]",
            isMobilePeopleLayout && "min-w-[200px] shrink-0"
          )}
        >
          <Text className="text-xs font-medium text-muted-foreground">
            Email
          </Text>
        </View>
        <View className={cn("w-24", isMobilePeopleLayout && "shrink-0")}>
          <Text className="text-xs font-medium text-muted-foreground">
            Role
          </Text>
        </View>
        <View className={cn("w-28", isMobilePeopleLayout && "shrink-0")}>
          <Text className="text-xs font-medium text-muted-foreground">
            Sent
          </Text>
        </View>
        <View className={cn("w-24", isMobilePeopleLayout && "shrink-0")}>
          <Text className="text-xs font-medium text-muted-foreground">
            Status
          </Text>
        </View>
        <View className={cn("w-8", isMobilePeopleLayout && "shrink-0")} />
      </View>

      {sentInvitations.map((inv: any) => {
        const isExpired =
          inv.status === "expired" || Date.now() > inv.expiresAt;
        const status = isExpired ? "expired" : (inv.status as string);
        const isDimmed = status === "expired" || status === "declined";
        const badgeVariant =
          status === "accepted"
            ? "default"
            : status === "declined"
            ? "destructive"
            : status === "expired"
            ? "outline"
            : "secondary";
        const badgeLabel =
          status === "accepted"
            ? "Accepted"
            : status === "declined"
            ? "Declined"
            : status === "expired"
            ? "Expired"
            : "Pending";
        return (
          <View
            key={inv.id}
            className={cn(
              "flex-row items-center px-4 py-3 border-b border-border",
              isDimmed && "opacity-50"
            )}
          >
            <View
              className={cn(
                "flex-[2] min-w-0",
                isMobilePeopleLayout && "min-w-[200px] shrink-0"
              )}
            >
              <Text
                className={cn(
                  "text-sm text-foreground",
                  isDimmed && "line-through"
                )}
                numberOfLines={2}
              >
                {inv.email}
              </Text>
            </View>
            <View className={cn("w-24", isMobilePeopleLayout && "shrink-0")}>
              <Text className="text-sm text-foreground capitalize">
                {ROLE_DISPLAY[inv.role] || inv.role}
              </Text>
            </View>
            <View className={cn("w-28", isMobilePeopleLayout && "shrink-0")}>
              <Text className="text-sm text-foreground">
                {new Date(inv.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </Text>
            </View>
            <View className={cn("w-24", isMobilePeopleLayout && "shrink-0")}>
              <Badge variant={badgeVariant}>{badgeLabel}</Badge>
            </View>
            <View
              className={cn(
                "w-8 items-center",
                isMobilePeopleLayout && "shrink-0"
              )}
            >
              {status === "pending" && canManageMembers && (
                <Pressable
                  onPress={() =>
                    setRevokeInvitationTarget({ id: inv.id, email: inv.email })
                  }
                >
                  <X size={14} className="text-muted-foreground" />
                </Pressable>
              )}
            </View>
          </View>
        );
      })}

      <View className="px-4 py-2.5">
        <Text className="text-xs text-muted-foreground">
          Showing 1-{sentInvitations.length} of {sentInvitations.length}
        </Text>
      </View>
    </>
  );

  const billableSeats = workspaceMembers.filter(
    (m: any) => m.role !== "viewer"
  ).length;

  // Same host as the usage numbers on screen, machine included (SHO-108/SHO-91).
  const exportCsvUrl = useUsageLogCsvUrl(currentWorkspace?.id, { period: "30d" });

  const handleExportMembersCsv = () => {
    if (!currentWorkspace?.id) return;
    const url = exportCsvUrl;
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener");
    } else {
      openExternalLink(url);
    }
  };

  return (
    <View className="gap-0">
      {/* Header */}
      <View
        className={cn(
          "flex-row items-start justify-between gap-3 mb-4",
          isMobilePeopleLayout && "flex-col mb-5"
        )}
      >
        <View className="flex-1">
          <Text className="text-xl font-semibold text-foreground">Members</Text>
          <Text
            className={cn(
              "text-sm text-muted-foreground mt-1",
              isMobilePeopleLayout && "leading-5"
            )}
          >
            Inviting people to{" "}
            <Text className="font-semibold text-foreground">
              {resolvedWs?.name || currentWorkspace?.name || "your workspace"}
            </Text>{" "}
            gives access to workspace shared projects and usage.
          </Text>
        </View>
        <Pressable
          onPress={handleExportMembersCsv}
          hitSlop={6}
          className="h-9 w-9 items-center justify-center rounded-md border border-border"
          accessibilityLabel="Export usage CSV"
        >
          <Download size={14} className="text-foreground" />
        </Pressable>
      </View>

      {/* Billable seats stat */}
      <View className="rounded-xl border border-border bg-card p-4 mb-4">
        <View className="flex-row items-center gap-2 mb-1">
          <View className="h-2 w-2 rounded-full bg-emerald-500" />
          <Text className="text-xs font-medium text-foreground">
            Billable Seats
          </Text>
        </View>
        <Text className="text-2xl font-bold text-foreground">
          {billableSeats}
        </Text>
      </View>

      {/* Sub-tabs */}
      <View className="flex-row border-b border-border mb-4">
        {SUB_TABS.map((tab) => (
          <Pressable
            key={tab.id}
            onPress={() => {
              setSubTab(tab.id);
              setShowRoleFilter(false);
              setMenuState(null);
            }}
            className={cn(
              "px-4 py-2.5 mr-1",
              subTab === tab.id ? "border-b-2 border-foreground" : ""
            )}
          >
            <Text
              className={cn(
                "text-sm",
                subTab === tab.id
                  ? "text-foreground font-medium"
                  : "text-muted-foreground"
              )}
            >
              {tab.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Who can invite (SHO-454). Owners and admins only. */}
      {canManageSettings && (
        <View className="mb-4 flex-row items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
          <View className="min-w-0 flex-1">
            <Text className="text-sm font-medium text-foreground">Who can invite</Text>
            <Text className="text-xs text-muted-foreground">
              {policy === "admins"
                ? "Only owners and admins can invite people."
                : "Anyone except Viewers can invite people as Editor or Viewer."}
            </Text>
          </View>
          <View className="flex-row items-center gap-1 rounded-lg border border-border p-1">
            {(["members", "admins"] as const).map((option) => (
              <Pressable
                key={option}
                disabled={savingPolicy}
                onPress={() => void changePolicy(option)}
                accessibilityRole="radio"
                aria-checked={policy === option}
                accessibilityLabel={option === "members" ? "Anyone except Viewers" : "Admins only"}
                className={cn(
                  "rounded-md px-2.5 py-1.5",
                  policy === option && "bg-muted",
                )}
              >
                <Text className="text-xs text-foreground">
                  {option === "members" ? "Anyone except Viewers" : "Admins only"}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {/* Controls row */}
      <View
        className={cn(
          "mb-4",
          isMobilePeopleLayout
            ? "flex-col gap-3"
            : "flex-row items-center gap-2 flex-wrap"
        )}
      >
        {subTab === "all" && (
          <>
            <View
              className={cn(
                "flex-row items-center border border-border rounded-lg px-3",
                isMobilePeopleLayout
                  ? "w-full h-11"
                  : "h-9 flex-1 min-w-[160px]"
              )}
            >
              <Search
                size={14}
                className="text-muted-foreground mr-2 shrink-0"
              />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search..."
                className={cn(
                  "flex-1 text-sm text-foreground placeholder:text-muted-foreground web:outline-none web:min-h-0",
                  isMobilePeopleLayout && "py-0 leading-5 web:py-1.5"
                )}
                autoCapitalize="none"
                autoCorrect={false}
                textAlignVertical={isMobilePeopleLayout ? "center" : undefined}
              />
            </View>

            <Pressable
              onPress={() => setShowRoleFilter(true)}
              className={cn(
                "flex-row items-center px-3 border border-border rounded-lg gap-1.5",
                isMobilePeopleLayout ? "w-full justify-between h-11" : "h-9"
              )}
            >
              <Text className="text-sm text-foreground">
                {roleFilter === "all"
                  ? "All roles"
                  : ROLE_DISPLAY[roleFilter] || roleFilter}
              </Text>
              <ChevronDown size={14} className="text-muted-foreground" />
            </Pressable>

            <View className="flex-row items-center gap-1 rounded-lg border border-border p-1">
              {(["7d", "30d", "90d"] as MemberUsagePeriod[]).map((period) => (
                <Pressable
                  key={period}
                  onPress={() => setMemberUsagePeriod(period)}
                  className={cn(
                    "rounded-md px-2.5 py-1.5",
                    memberUsagePeriod === period && "bg-muted"
                  )}
                >
                  <Text className="text-xs text-foreground">{period}</Text>
                </Pressable>
              ))}
            </View>
          </>
        )}

        {subTab === "invitations" && !isMobilePeopleLayout && (
          <View className="flex-1" />
        )}

        {canInvite && (
          <Pressable
            onPress={() => inviteDialog.openInviteDialog(currentWorkspace?.id ?? null)}
            className={cn(
              "flex-row items-center gap-1.5 px-3 bg-primary rounded-lg",
              isMobilePeopleLayout ? "w-full justify-center h-11" : "h-9"
            )}
          >
            <UserPlus size={14} className="text-primary-foreground" />
            <Text className="text-sm font-medium text-primary-foreground">
              Invite members
            </Text>
          </Pressable>
        )}
      </View>

      {/* Content based on sub-tab */}
      {subTab === "all" && (
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <View className="py-12 items-center">
                <ActivityIndicator size="small" />
                <Text className="text-sm text-muted-foreground mt-2">
                  Loading members...
                </Text>
              </View>
            ) : filteredMembers.length === 0 ? (
              <View className="py-12 items-center px-6">
                <Users size={32} className="text-muted-foreground/50 mb-3" />
                <Text className="text-sm text-muted-foreground">
                  {search.trim() || roleFilter !== "all"
                    ? "No members match your filters"
                    : "No members yet. Invite someone to collaborate."}
                </Text>
              </View>
            ) : (
              <ScrollView
                horizontal
                nestedScrollEnabled
                showsHorizontalScrollIndicator={Platform.OS !== "web"}
                className="w-full max-w-full"
                style={{ flexGrow: 0 }}
                contentContainerStyle={{ flexGrow: 1 }}
              >
                <View className="flex-1">{memberListTable}</View>
              </ScrollView>
            )}
          </CardContent>
        </Card>
      )}

      {subTab === "all" && !isLoading && projectGuests.length > 0 && (
        <View className="mt-6">
          <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1 px-1">
            Project guests
          </Text>
          <Text className="text-sm text-muted-foreground mb-2 px-1">
            People outside the workspace who were added to specific projects.
            They don't count as workspace members.
          </Text>
          <Card>
            <CardContent className="p-0">
              {projectGuests.map((guest) => {
                const resolved = userMap[guest.userId];
                const gName = resolved?.name || resolved?.email || guest.userId;
                return (
                  <View
                    key={guest.userId}
                    className="px-4 py-3 border-b border-border gap-2"
                  >
                    <View className="flex-row items-center gap-3">
                      <View className="h-8 w-8 rounded-full items-center justify-center shrink-0 bg-slate-400">
                        <Text className="text-xs font-semibold text-white">
                          {(gName || "G")[0]?.toUpperCase()}
                        </Text>
                      </View>
                      <View className="min-w-0 flex-1">
                        <Text
                          className="text-sm font-medium text-foreground"
                          numberOfLines={1}
                        >
                          {gName}
                        </Text>
                        {resolved?.email && resolved.email !== gName ? (
                          <Text
                            className="text-xs text-muted-foreground"
                            numberOfLines={1}
                          >
                            {resolved.email}
                          </Text>
                        ) : null}
                      </View>
                      <Badge variant="outline">Guest</Badge>
                    </View>
                    {guest.grants.map((grant) => (
                      <View
                        key={grant.memberId}
                        className="flex-row items-center justify-between pl-11"
                      >
                        <Text
                          className="text-xs text-muted-foreground flex-1"
                          numberOfLines={1}
                        >
                          {grant.projectName} ·{" "}
                          {ROLE_DISPLAY[grant.role] || grant.role}
                        </Text>
                        {canManageMembers && (
                          <Pressable
                            onPress={() => handleRemoveMember(grant.memberId)}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={`Remove ${gName} from ${grant.projectName}`}
                          >
                            <Text className="text-xs text-destructive">
                              Remove
                            </Text>
                          </Pressable>
                        )}
                      </View>
                    ))}
                  </View>
                );
              })}
            </CardContent>
          </Card>
        </View>
      )}

      {subTab === "invitations" && (
        <View className="gap-4">
          {/* Sent invitations */}
          <View>
            <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">
              Sent
            </Text>
            <Card>
              <CardContent className="p-0">
                {isLoading ? (
                  <View className="py-12 items-center">
                    <ActivityIndicator size="small" />
                    <Text className="text-sm text-muted-foreground mt-2">
                      Loading...
                    </Text>
                  </View>
                ) : sentInvitations.length === 0 ? (
                  <View className="py-16 items-center px-6">
                    <View className="h-12 w-12 rounded-lg bg-muted/50 items-center justify-center mb-4">
                      <Mail size={24} className="text-muted-foreground/50" />
                    </View>
                    <Text className="text-base font-medium text-foreground mb-2">
                      No invitations found
                    </Text>
                    {canInvite && (
                      <Pressable
                        onPress={() => inviteDialog.openInviteDialog(currentWorkspace?.id ?? null)}
                        className="flex-row items-center gap-1.5 mt-2 px-4 py-2 border border-border rounded-lg"
                      >
                        <UserPlus size={14} className="text-foreground" />
                        <Text className="text-sm font-medium text-foreground">
                          Invite members
                        </Text>
                      </Pressable>
                    )}
                  </View>
                ) : (
                  <>
                    {isMobilePeopleLayout ? (
                      <ScrollView
                        horizontal
                        nestedScrollEnabled
                        showsHorizontalScrollIndicator={Platform.OS !== "web"}
                        className="w-full max-w-full"
                        style={{ flexGrow: 0 }}
                      >
                        <View>{sentInvitationListTable}</View>
                      </ScrollView>
                    ) : (
                      sentInvitationListTable
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </View>
        </View>
      )}

      {/* Invite Members Modal */}
      {/* Role Filter Modal */}
      <Modal
        visible={showRoleFilter}
        transparent
        animationType="fade"
        onRequestClose={() => setShowRoleFilter(false)}
      >
        <Pressable
          className="flex-1 bg-black/50 justify-center items-center px-6"
          onPress={() => setShowRoleFilter(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="bg-background rounded-xl p-5 w-full max-w-xs gap-1"
          >
            <Text className="text-base font-semibold text-foreground mb-2">
              Filter by role
            </Text>
            {[
              { value: "all", label: "All roles" },
              { value: "owner", label: "Owner" },
              { value: "admin", label: "Admin" },
              { value: "member", label: "Editor" },
              { value: "viewer", label: "Viewer" },
            ].map((opt) => (
              <Pressable
                key={opt.value}
                onPress={() => {
                  setRoleFilter(opt.value);
                  setShowRoleFilter(false);
                }}
                className={cn(
                  "py-3 border-b border-border",
                  roleFilter === opt.value && "bg-accent rounded-md px-3"
                )}
              >
                <Text
                  className={cn(
                    "text-sm",
                    roleFilter === opt.value
                      ? "text-foreground font-medium"
                      : "text-foreground"
                  )}
                >
                  {opt.label}
                </Text>
              </Pressable>
            ))}
            <Pressable
              onPress={() => setShowRoleFilter(false)}
              className="py-2 mt-1"
            >
              <Text className="text-sm text-muted-foreground text-center">
                Cancel
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Inviting is the shared dialog (SHO-454); the People list refreshes
          when it closes so a new pending invite shows up. */}
      <Modal
        visible={revokeInvitationTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!isRevokingInvitation) setRevokeInvitationTarget(null);
        }}
      >
        <Pressable
          className="flex-1 bg-black/50 justify-center items-center px-6"
          onPress={() => {
            if (!isRevokingInvitation) setRevokeInvitationTarget(null);
          }}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="bg-background rounded-xl p-5 w-full max-w-sm gap-3"
          >
            <Text className="text-base font-semibold text-foreground">
              Revoke invitation?
            </Text>
            <Text className="text-sm text-muted-foreground leading-5">
              Cancel this invitation? The invite link will no longer work.
            </Text>
            {revokeInvitationTarget?.email ? (
              <Text className="text-sm font-medium text-foreground">
                {revokeInvitationTarget.email}
              </Text>
            ) : null}
            <View className="flex-row gap-2 justify-end mt-2">
              <Pressable
                disabled={isRevokingInvitation}
                onPress={() => setRevokeInvitationTarget(null)}
                className={cn(
                  "px-4 py-2.5 rounded-lg border border-border items-center justify-center",
                  isRevokingInvitation && "opacity-50"
                )}
              >
                <Text className="text-sm font-medium text-foreground">
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                disabled={isRevokingInvitation}
                onPress={confirmRevokeInvitation}
                className={cn(
                  "px-4 py-2.5 rounded-lg bg-destructive items-center justify-center",
                  isRevokingInvitation && "opacity-50"
                )}
              >
                <Text className="text-sm font-medium text-destructive-foreground">
                  {isRevokingInvitation ? "Revoking…" : "Revoke"}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Member Action Modal */}
      <Modal
        visible={menuState !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuState(null)}
      >
        <Pressable
          className="flex-1 bg-black/50 justify-center items-center px-6"
          onPress={() => setMenuState(null)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="bg-background rounded-xl p-5 w-full max-w-xs gap-3"
          >
            {menuState?.view === "actions" && (
              <>
                <Text className="text-base font-semibold text-foreground mb-1">
                  Member actions
                </Text>
                <Pressable
                  onPress={() => {
                    if (menuState)
                      setMenuState({ ...menuState, view: "roles" });
                  }}
                  className="py-3 border-b border-border"
                >
                  <Text className="text-sm text-foreground">Change role</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    if (menuState) handleRemoveMember(menuState.memberId);
                  }}
                  className="py-3"
                >
                  <Text className="text-sm text-destructive">
                    Remove member
                  </Text>
                </Pressable>
              </>
            )}
            {menuState?.view === "roles" && (
              <>
                <Text className="text-base font-semibold text-foreground mb-1">
                  Select role
                </Text>
                {roleOptionsFor({ isOwner }).map((r) => {
                  const activeMember = workspaceMembers.find(
                    (m: any) => m.id === menuState?.memberId
                  );
                  const isActive = activeMember?.role === r;
                  return (
                    <Pressable
                      key={r}
                      onPress={() => {
                        if (menuState) handleChangeRole(menuState.memberId, r);
                      }}
                      className={cn(
                        "py-3 border-b border-border",
                        isActive && "bg-accent rounded-md px-3"
                      )}
                    >
                      <Text
                        className={cn(
                          "text-sm",
                          isActive
                            ? "text-foreground font-medium"
                            : "text-foreground"
                        )}
                      >
                        {ROLE_DISPLAY[r]}
                      </Text>
                    </Pressable>
                  );
                })}
              </>
            )}
            <Pressable onPress={() => setMenuState(null)} className="py-2 mt-1">
              <Text className="text-sm text-muted-foreground text-center">
                Cancel
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <MemberUsageDetail
        visible={selectedMemberId !== null}
        member={selectedMemberInsight}
        loading={isLoadingMemberInsight}
        period={memberUsagePeriod}
        onPeriodChange={handleMemberUsagePeriodChange}
        onClose={() => {
          setSelectedMemberId(null);
          setSelectedMemberInsight(null);
          setIsLoadingMemberInsight(false);
        }}
      />
    </View>
  );
});


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
  const { can } = usePermissions({ workspaceId: workspace?.id });
  // Workspace analytics are owner/admin only; a member has no page to open.
  const canViewAnalytics = can("workspace.analytics:read");
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
                  trust blocks: $25 → $500)
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
            {canViewAnalytics ? (
              <Button
                variant="outline"
                onPress={() =>
                  router.push("/(app)/analytics" as any)
                }
                className="flex-1"
              >
                <Text className="text-foreground font-medium">
                  View detailed usage
                </Text>
              </Button>
            ) : null}
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
    // Local mode: no billing gate, so the name modal always (never the paid
    // `/(app)/new-workspace` checkout page).
    if (pooledWorkspaceParent || localMode || !hasTeamWorkspace) {
      setCreateWorkspaceOpen(true);
      return;
    }
    router.push("/(app)/new-workspace" as any);
  }, [hasTeamWorkspace, localMode, pooledWorkspaceParent, router]);

  const handleCreateWorkspaceSubmit = useCallback(
    async (name: string) => {
      if (pooledWorkspaceParent) return createPooledWorkspace(name);
      if (!user?.id) return false;
      try {
        const created = await actions.createWorkspace(name, undefined, user.id);
        if (created?.id) {
          trackEvent(posthog, EVENTS.WORKSPACE_CREATED);
          setActiveWorkspaceId(created.id);
          await workspaces.loadAll();
          // Same path as switching to an existing workspace: rebind the shell to
          // the new workspace's data and runtime, don't just highlight it.
          scheduleWorkspaceSwitch(created.id, projects, reloadAfterWorkspaceSwitch);
        }
      } catch (err) {
        console.warn("Failed to create workspace:", err);
        return workspaceErrorMessage(err);
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
                  aria-selected={isCurrent}
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
              onPress={() => void openExternalLink(DOCS_URL)}
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
              onPress={() => void openExternalLink(CHANGELOG_URL)}
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
      {showSignOut ? (
        <EnvironmentVersionTrigger className={cn(sidebar ? "mt-4 px-2.5 py-1" : "py-1")} />
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

/**
 * Settings → Workspace → Disk (SHO-401). The workspace runtime's own drive,
 * editable by owners/admins. Read-only for everyone else.
 */
const WorkspaceDiskTab = observer(function WorkspaceDiskTab() {
  const http = useDomainHttp();
  const currentWorkspace = useActiveWorkspace();
  const { can } = usePermissions({ workspaceId: currentWorkspace?.id });
  if (!currentWorkspace?.id || !http) {
    return (
      <View className="flex-1 items-center justify-center p-6">
        <Text className="text-sm text-muted-foreground">No workspace selected.</Text>
      </View>
    );
  }
  if (!can("workspace:update")) {
    return (
      <View className="flex-1 items-center justify-center p-6">
        <Text className="text-sm text-muted-foreground">
          Only workspace owners and admins can change the workspace disk.
        </Text>
      </View>
    );
  }
  return <DiskSettings scope="workspace" workspaceId={currentWorkspace.id} http={http} />;
});

export const SettingsContent = observer(function SettingsContent({
  activeTab,
  localMode = false,
  onSelectTab,
  onClose,
  section,
}: {
  activeTab: TabId;
  localMode?: boolean;
  onSelectTab?: (tab: TabId) => void;
  /** Set when Settings is shown in a sheet that must close before navigating away. */
  onClose?: () => void;
  /** `?section=` deep link inside a tab, e.g. `agent-concurrency` on Chat. */
  section?: string;
}) {
  const isLocal = localMode;
  return (
    <>
      {activeTab === "workspace" && <WorkspaceSettingsTab />}
      {activeTab === "disk" && <WorkspaceDiskTab />}
      {activeTab === "people" && !isLocal && <PeopleTab />}
      {activeTab === "chat" && <ChatPreferencesTab highlightSection={section} />}
      {activeTab === "models" && <WorkspaceModelsTab />}
      {activeTab === "access" && <WorkspaceAccessTab />}
      {activeTab === "integrations" && <IntegrationsTab />}
      {activeTab === "automations" && (
        <AutomationsTab
          onOpenIntegrations={onSelectTab ? () => onSelectTab("integrations") : undefined}
          onLeaveSettings={onClose}
        />
      )}
      {activeTab === "data" && <WorkspaceExportView />}
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
  const params = useLocalSearchParams<{ tab?: string; workspace?: string; section?: string }>();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isWide = width >= SETTINGS_WIDE_BREAKPOINT;
  // Phone (native handset or web ≤767px) has its own Settings surface: the
  // Account screen with `NativeAccountSettingsSheet`. This page stays the
  // wide/tablet one and redirects below — the single insert point for every
  // `/settings?tab=…` deep link, so no caller changes.
  const isPhoneSurface = isPhoneSettingsSurface(width, height);
  // Mirrors `showSidebar` in `(app)/_layout.tsx`: wide web renders the app
  // sidebar beside this page, so the page drops its own exit and switcher.
  const inAppShell = !onClose && Platform.OS === "web" && isWide;
  const isNativePhone = isNativePhoneIntegrationsLayout(width, height);
  const { user } = useAuth();
  const workspaces = useWorkspaceCollection();
  const { features, localMode } = usePlatformConfig();
  const teamChat = useWorkspaceExperience().kind === "team";
  const activeWorkspace = useActiveWorkspace();
  const { can } = usePermissions({ workspaceId: activeWorkspace?.id });
  const canViewAnalytics = can("workspace.analytics:read");
  // A desktop cloud workspace manages its members in the app, so the People
  // tab exists there even though the desktop itself is in local mode (SHO-454).
  const showPeopleTab = !(localMode || !features.billing) || isCloudWorkspace(activeWorkspace?.id);
  const phoneTarget = phoneSettingsTarget(
    params as Record<string, string | string[] | undefined>,
    {
      localMode: localMode || !features.billing,
      showBilling: features.billing,
      platform: Platform.OS,
      isDesktop: IS_DESKTOP_CLIENT,
      teamChat,
      canViewAnalytics,
    },
  );

  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const requested = params.tab as TabId;
    return ALL_TAB_IDS.includes(requested) ? requested : "workspace";
  });

  // Usage and Cost Optimizer now live on the Analytics screen; keep old links working.
  useEffect(() => {
    // The phone redirect already targets Analytics — never navigate twice.
    if (isPhoneSurface) return;
    // Members have no analytics surface: leave them on Settings.
    if (!canViewAnalytics) return;
    if (params.tab === "analytics" || params.tab === "costs") {
      router.replace({
        pathname: "/(app)/analytics",
        params: { view: params.tab === "costs" ? "costs" : "usage" },
      } as any);
    }
  }, [isPhoneSurface, params.tab, router, canViewAnalytics]);

  useEffect(() => {
    if (isPhoneSurface) return;
    const ownWorkspaceIds =
      workspaces?.all?.map((workspace: any) => workspace.id) ?? [];
    const resolvedWorkspace = resolveRequestedWorkspaceId(
      params.workspace,
      ownWorkspaceIds,
    );
    if (resolvedWorkspace) setActiveWorkspaceId(resolvedWorkspace);
  }, [isPhoneSurface, params.workspace, workspaces?.all, workspaces?.isLoading]);

  useEffect(() => {
    if (isPhoneSurface) return;
    const isLocal = localMode || !features.billing;
    if (activeTab === "people" && isLocal) setActiveTab("workspace");
    if (activeTab === "chat" && !teamChat) setActiveTab("workspace");
    if (activeTab === "compute" && (isLocal || HIDE_COMPUTE_PURCHASES_ON_IOS))
      setActiveTab("workspace");
    if (activeTab === "updates" && !IS_DESKTOP_CLIENT)
      setActiveTab("workspace");
    if (activeTab === "computer-files" && (!IS_DESKTOP_CLIENT || !isLocal))
      setActiveTab("workspace");
  }, [activeTab, features.billing, localMode, teamChat]);

  const userName = user?.name || "";
  const activeTabLabel = settingsTab(activeTab).label;
  const exitSettings = () => {
    if (onClose) {
      onClose();
      return;
    }
    leaveSettings(router, isNativePhone);
  };

  // Phone lands on the Account screen with the mapped tab's sheet open. The
  // wide branch below (and the tablet page) is unchanged.
  if (isPhoneSurface) {
    return <Redirect href={phoneTarget as any} />;
  }

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
            userName={userName}
            onExit={inAppShell ? undefined : exitSettings}
            showBilling={features.billing}
            localMode={localMode}
            teamChat={teamChat}
            showPeople={showPeopleTab}
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
                onPress={() => openExternalLink(DOCS_URL)}
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
              section={typeof params.section === "string" ? params.section : undefined}
            />
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View
      testID="settings-legacy-page"
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top }}
    >
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
          teamChat={teamChat}
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
            section={typeof params.section === "string" ? params.section : undefined}
          />
        </View>
      </ScrollView>
    </View>
  );
});
