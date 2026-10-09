// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings > People: workspace member management.
 *
 * The "All" sub-tab is a people-first list (member, role, one usage figure and
 * an always-visible actions menu). Per-member usage detail and the role /
 * remove / leave controls live in the member detail sheet. The "Invitations"
 * sub-tab lists received and sent invitations.
 */
import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
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
import { observer } from "mobx-react-lite";
import {
  ChevronDown as ChevronDownIcon,
  Download as DownloadIcon,
  Mail as MailIcon,
  Search as SearchIcon,
  UserPlus as UserPlusIcon,
  Users as UsersIcon,
  X as XIcon,
} from "lucide-react-native";
import { Badge, Card, CardContent, cn } from "@shogo/shared-ui/primitives";
import { useDomainActions } from "@shogo/shared-app/domain";
import {
  Toast,
  ToastDescription,
  ToastTitle,
  useToast,
} from "@/components/ui/toast";
import {
  Text,
  TextInput,
  useAccountSheetIcons,
} from "../account-sheet-chrome";
import { useAuth } from "../../../contexts/auth";
import {
  useDomainHttp,
  useInvitationCollection,
  useMemberCollection,
  useWorkspaceCollection,
} from "../../../contexts/domain";
import { useActiveWorkspace } from "../../../hooks/useActiveWorkspace";
import {
  api,
  isInvitationExpired,
  type MemberInsight,
  type MemberInsightsData,
} from "../../../lib/api";
import { invitationEvents } from "../../../lib/invitation-events";
import { WEB_WIDE_MIN_WIDTH } from "../../../lib/native-phone-layout";
import { MemberDetailSheet } from "../MemberUsageDetail";
import { InviteMembersModal } from "./InviteMembersModal";
import { LeaveWorkspaceDialog } from "./LeaveWorkspaceDialog";
import { MemberAccessSection } from "./MemberAccessSection";
import {
  MEMBER_COL_ACTIONS,
  MEMBER_COL_ROLE,
  MEMBER_COL_USAGE,
  MemberRow,
} from "./MemberRow";
import { RemoveMemberDialog } from "./RemoveMemberDialog";
import {
  ROLE_DISPLAY,
  ROLE_PRIORITY,
  canManageMembers,
  getErrorMessage,
  type WorkspaceRole,
} from "./member-permissions";

const PEOPLE_ICON_MAP = {
  ChevronDown: ChevronDownIcon,
  Download: DownloadIcon,
  Mail: MailIcon,
  Search: SearchIcon,
  UserPlus: UserPlusIcon,
  Users: UsersIcon,
  X: XIcon,
} as const;

/** Tablet/desktop split: matches the Settings page `isWide` (sidebar layout). */
const SETTINGS_WIDE_BREAKPOINT = WEB_WIDE_MIN_WIDTH;

type PeopleSubTab = "all" | "invitations";
type SortField = "name" | "role" | "usage";
type SortDir = "asc" | "desc";
type MemberUsagePeriod = "7d" | "30d" | "90d";

function formatUsdLabel(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

function SortHeader({
  label,
  field,
  sortField,
  sortDir,
  onSort,
  className,
  align = "left",
}: {
  label: string;
  field: SortField;
  sortField: SortField;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
  className?: string;
  align?: "left" | "right";
}) {
  const active = sortField === field;
  return (
    <Pressable
      onPress={() => onSort(field)}
      accessibilityRole="button"
      accessibilityLabel={`Sort by ${label}`}
      className={cn(
        "flex-row items-center gap-1",
        align === "right" && "justify-end",
        className
      )}
    >
      <Text className="text-xs font-medium text-muted-foreground">{label}</Text>
      <Text
        className={cn(
          "text-[8px]",
          active ? "text-foreground" : "text-muted-foreground/40"
        )}
      >
        {active && sortDir === "desc" ? "▼" : "▲"}
      </Text>
    </Pressable>
  );
}

export const PeopleTab = observer(function PeopleTab() {
  const { X, ChevronDown, Download, Search, UserPlus, Users, Mail } =
    useAccountSheetIcons(PEOPLE_ICON_MAP);
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

  const [subTab, setSubTab] = useState<PeopleSubTab>("all");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [showRoleFilter, setShowRoleFilter] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [sortField, setSortField] = useState<SortField>("role");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [isLoading, setIsLoading] = useState(true);
  const hasLoadedOnce = useRef(false);
  const [userMap, setUserMap] = useState<
    Record<string, { name: string; email: string }>
  >({});
  const [receivedInvites, setReceivedInvites] = useState<any[]>([]);
  const [processingInvite, setProcessingInvite] = useState<{
    id: string;
    action: "accept" | "decline";
  } | null>(null);

  const [resolvedWs, setResolvedWs] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [memberUsagePeriod, setMemberUsagePeriod] =
    useState<MemberUsagePeriod>("30d");
  const [memberInsights, setMemberInsights] = useState<MemberInsightsData>({
    rows: [],
    total: 0,
  });
  /** User id of the member whose detail sheet is open. */
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedMemberInsight, setSelectedMemberInsight] =
    useState<MemberInsight | null>(null);
  const [isLoadingMemberInsight, setIsLoadingMemberInsight] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [isLeaveDialogOpen, setIsLeaveDialogOpen] = useState(false);

  const showToast = useCallback(
    (action: "success" | "error", title: string, description?: string) => {
      toast.show({
        placement: "top",
        duration: action === "error" ? 5000 : 3000,
        render: ({ id }: { id: string }) => (
          <Toast nativeID={id} variant="outline" action={action}>
            <ToastTitle>{title}</ToastTitle>
            {description ? (
              <ToastDescription>{description}</ToastDescription>
            ) : null}
          </Toast>
        ),
      });
    },
    [toast]
  );

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
    // Only show the full-list spinner on the first load; later refreshes
    // (after removing someone, changing period, ...) update in place.
    if (!hasLoadedOnce.current) setIsLoading(true);
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

        try {
          const insights = await api.getMemberInsights(http, ws.id, {
            period: memberUsagePeriod,
          });
          setMemberInsights(insights);
        } catch {
          setMemberInsights({ rows: [], total: 0 });
        }

        if (user?.email) {
          try {
            const rawPending = await api.getReceivedInvitations(
              http,
              user.email
            );
            setReceivedInvites(Array.isArray(rawPending) ? rawPending : []);
          } catch {}
        }
      }
    } catch {}
    hasLoadedOnce.current = true;
    setIsLoading(false);
  }, [
    workspaces,
    members,
    invitations,
    http,
    currentWorkspace?.id,
    user?.email,
    memberUsagePeriod,
  ]);

  useEffect(() => {
    loadPeopleData();
  }, [loadPeopleData]);

  useEffect(() => invitationEvents.subscribe(loadPeopleData), [loadPeopleData]);

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

  const currentUserMembership = workspaceMembers.find(
    (m: any) => m.userId === user?.id
  );
  const viewerRole: string | undefined = currentUserMembership?.role;
  const canManage = canManageMembers(viewerRole);
  const workspaceCount = (Array.isArray(workspaces.all) ? workspaces.all : [])
    .length;
  const otherOwnerCount = workspaceMembers.filter(
    (m: any) => m.role === "owner" && m.userId !== user?.id
  ).length;
  const workspaceName =
    resolvedWs?.name || currentWorkspace?.name || "your workspace";

  const describeMember = useCallback(
    (member: any) => {
      const isSelf = member.userId === user?.id;
      const resolved = userMap[member.userId];
      const name =
        (isSelf ? user?.name || user?.email : resolved?.name || resolved?.email) ||
        member.userId;
      const email =
        (isSelf ? user?.email : resolved?.email) || member.userId;
      return { isSelf, name: name as string, email: email as string };
    },
    [user?.id, user?.name, user?.email, userMap]
  );

  /** Usage is visible to managers (everyone) and to members for themselves. */
  const canSeeUsageFor = useCallback(
    (member: any) => canManage || member.userId === user?.id,
    [canManage, user?.id]
  );

  const filteredMembers = useMemo(() => {
    let result = [...workspaceMembers];
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((m: any) => {
        const { name, email } = describeMember(m);
        return (
          name.toLowerCase().includes(q) ||
          email.toLowerCase().includes(q) ||
          (m.userId || "").toLowerCase().includes(q)
        );
      });
    }
    if (roleFilter !== "all") {
      result = result.filter((m: any) => m.role === roleFilter);
    }
    const spendOf = (m: any) => memberInsightMap.get(m.userId)?.spendUsd ?? 0;
    const nameOf = (m: any) => describeMember(m).name;
    result.sort((a: any, b: any) => {
      let cmp = 0;
      if (sortField === "role") {
        cmp = (ROLE_PRIORITY[a.role] ?? 9) - (ROLE_PRIORITY[b.role] ?? 9);
      } else if (sortField === "usage") {
        cmp = spendOf(a) - spendOf(b);
      }
      if (cmp === 0) {
        // Names always break ties ascending so the order is stable.
        const byName = nameOf(a).localeCompare(nameOf(b));
        return sortField === "name" && sortDir === "desc" ? -byName : byName;
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
    memberInsightMap,
    describeMember,
  ]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "usage" ? "desc" : "asc");
    }
  };

  const selectedMember = selectedUserId
    ? workspaceMembers.find((m: any) => m.userId === selectedUserId) ?? null
    : null;

  const closeDetailSheet = useCallback(() => {
    setSelectedUserId(null);
    setSelectedMemberInsight(null);
    setIsLoadingMemberInsight(false);
  }, []);

  const handleOpenMemberDetails = useCallback(
    async (member: any) => {
      const memberUserId = member.userId as string;
      setSelectedUserId(memberUserId);
      setSelectedMemberInsight(memberInsightMap.get(memberUserId) ?? null);
      if (!http || !currentWorkspace?.id) return;
      if (!(canManage || memberUserId === user?.id)) return;

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
    [
      http,
      currentWorkspace?.id,
      memberUsagePeriod,
      memberInsightMap,
      canManage,
      user?.id,
    ]
  );

  const handleMemberUsagePeriodChange = useCallback(
    async (period: MemberUsagePeriod) => {
      setMemberUsagePeriod(period);
      if (!selectedUserId || !http || !currentWorkspace?.id) return;
      setIsLoadingMemberInsight(true);
      try {
        const data = await api.getMemberInsights(http, currentWorkspace.id, {
          period,
          userId: selectedUserId,
        });
        setSelectedMemberInsight(data.rows[0] ?? null);
      } catch {
        // Keep the current detail view if the refresh fails.
      } finally {
        setIsLoadingMemberInsight(false);
      }
    },
    [http, currentWorkspace?.id, selectedUserId]
  );

  const handleChangeRole = useCallback(
    async (member: any, newRole: WorkspaceRole) => {
      const { name } = describeMember(member);
      try {
        await actions.updateMemberRole(member.id, newRole, user?.id || "");
        await loadPeopleData();
        showToast("success", `${name} is now ${ROLE_DISPLAY[newRole]}`);
      } catch (err) {
        showToast(
          "error",
          "Failed to change role",
          getErrorMessage(err, "You may not have permission.")
        );
      }
    },
    [actions, user?.id, loadPeopleData, describeMember, showToast]
  );

  const requestRemove = useCallback(
    (member: any) => {
      // Close the sheet first: iOS can't present two modals at once.
      closeDetailSheet();
      setRemoveTarget({ id: member.id, name: describeMember(member).name });
    },
    [closeDetailSheet, describeMember]
  );

  const requestLeave = useCallback(() => {
    closeDetailSheet();
    setIsLeaveDialogOpen(true);
  }, [closeDetailSheet]);

  const confirmRemoveMember = useCallback(
    async (target: { id: string; name: string }) => {
      // Throws on failure; the dialog shows the server's message inline.
      await actions.removeMember(target.id, user?.id || "");
      setRemoveTarget(null);
      closeDetailSheet();
      showToast("success", `Removed ${target.name}`);
      await loadPeopleData();
    },
    [actions, user?.id, closeDetailSheet, showToast, loadPeopleData]
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

  const SUB_TABS: { id: PeopleSubTab; label: string }[] = [
    { id: "all", label: "All" },
    { id: "invitations", label: "Invitations" },
  ];

  const memberList = (
    <>
      {!isMobilePeopleLayout && (
        <View className="flex-row items-center gap-4 pl-4 pr-2 py-2.5 border-b border-border bg-muted/30">
          <SortHeader
            label="Member"
            field="name"
            sortField={sortField}
            sortDir={sortDir}
            onSort={handleSort}
            className="flex-1"
          />
          <SortHeader
            label="Role"
            field="role"
            sortField={sortField}
            sortDir={sortDir}
            onSort={handleSort}
            className={MEMBER_COL_ROLE}
          />
          <SortHeader
            label={`Usage · ${memberUsagePeriod}`}
            field="usage"
            sortField={sortField}
            sortDir={sortDir}
            onSort={handleSort}
            className={MEMBER_COL_USAGE}
            align="right"
          />
          <View className={MEMBER_COL_ACTIONS} />
        </View>
      )}

      {filteredMembers.map((member: any) => {
        const { isSelf, name, email } = describeMember(member);
        const spend = memberInsightMap.get(member.userId)?.spendUsd ?? 0;
        return (
          <MemberRow
            key={member.id}
            name={name}
            email={email}
            role={member.role}
            isSelf={isSelf}
            viewerRole={viewerRole}
            compact={isMobilePeopleLayout}
            usageLabel={canSeeUsageFor(member) ? formatUsdLabel(spend) : "—"}
            workspaceCount={workspaceCount}
            otherOwnerCount={otherOwnerCount}
            onViewDetails={() => void handleOpenMemberDetails(member)}
            onChangeRole={(role) => void handleChangeRole(member, role)}
            onRemove={() => requestRemove(member)}
            onLeave={requestLeave}
          />
        );
      })}

      <View className="px-4 py-2.5">
        <Text className="text-xs text-muted-foreground">
          {filteredMembers.length === workspaceMembers.length
            ? `${workspaceMembers.length} ${
                workspaceMembers.length === 1 ? "member" : "members"
              }`
            : `Showing ${filteredMembers.length} of ${workspaceMembers.length}`}
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
              {status === "pending" && (
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

  const handleExportMembersCsv = () => {
    if (!currentWorkspace?.id) return;
    const url = api.getUsageLogCsvUrl(currentWorkspace.id, { period: "30d" });
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener");
    } else {
      Linking.openURL(url);
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

        <Pressable
          onPress={() => setShowInviteModal(true)}
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
              memberList
            )}
          </CardContent>
        </Card>
      )}

      {subTab === "invitations" && (
        <View className="gap-4">
          {/* Received invitations */}
          <View>
            <Text className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">
              Received
            </Text>
            {receivedInvites.length === 0 ? (
              <Card>
                <CardContent className="py-6 items-center">
                  <Text className="text-sm text-muted-foreground">
                    No invitations
                  </Text>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-0">
                  {receivedInvites.map((inv: any) => {
                    const expired = isInvitationExpired(inv);
                    const isAccepting =
                      processingInvite?.id === inv.id &&
                      processingInvite?.action === "accept";
                    const isDeclining =
                      processingInvite?.id === inv.id &&
                      processingInvite?.action === "decline";
                    return (
                      <View key={inv.id} className="p-4 border-b border-border">
                        <View className="flex-row items-center justify-between mb-1">
                          <Text className="text-base font-semibold text-foreground">
                            {inv.workspace?.name ||
                              inv.workspaceName ||
                              "Workspace"}
                          </Text>
                          <View className="flex-row items-center gap-2">
                            {expired && (
                              <View className="px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-950/40">
                                <Text className="text-xs text-amber-700 dark:text-amber-300">
                                  Expired
                                </Text>
                              </View>
                            )}
                            <View className="px-2 py-0.5 rounded bg-muted">
                              <Text className="text-xs text-muted-foreground capitalize">
                                {ROLE_DISPLAY[inv.role] || inv.role}
                              </Text>
                            </View>
                          </View>
                        </View>
                        <Text className="text-sm text-muted-foreground mb-3">
                          {expired
                            ? "This invitation has expired. You can dismiss it or ask for a new invite."
                            : "You've been invited to join this workspace"}
                        </Text>
                        <View className="flex-row gap-2">
                          <Pressable
                            disabled={
                              expired || processingInvite?.id === inv.id
                            }
                            onPress={async () => {
                              setProcessingInvite({
                                id: inv.id,
                                action: "accept",
                              });
                              try {
                                await actions.acceptInvitation(
                                  inv.id,
                                  user?.id || "",
                                  {
                                    workspaceId: inv.workspaceId,
                                    role: inv.role,
                                    projectId: inv.projectId,
                                  }
                                );
                                setReceivedInvites((prev) =>
                                  prev.filter((i: any) => i.id !== inv.id)
                                );
                              } catch {}
                              loadPeopleData();
                              invitationEvents.emit();
                              setProcessingInvite(null);
                            }}
                            className={cn(
                              "flex-1 h-10 rounded-lg items-center justify-center",
                              expired ? "bg-muted" : "bg-primary",
                              (expired || processingInvite?.id === inv.id) &&
                                "opacity-50"
                            )}
                          >
                            {isAccepting ? (
                              <ActivityIndicator size="small" color="white" />
                            ) : (
                              <Text
                                className={cn(
                                  "text-sm font-medium",
                                  expired
                                    ? "text-muted-foreground"
                                    : "text-primary-foreground"
                                )}
                              >
                                {expired ? "Expired" : "Accept"}
                              </Text>
                            )}
                          </Pressable>
                          <Pressable
                            disabled={processingInvite?.id === inv.id}
                            onPress={async () => {
                              setProcessingInvite({
                                id: inv.id,
                                action: "decline",
                              });
                              try {
                                await actions.declineInvitation(inv.id);
                                setReceivedInvites((prev) =>
                                  prev.filter((i: any) => i.id !== inv.id)
                                );
                              } catch {}
                              loadPeopleData();
                              invitationEvents.emit();
                              setProcessingInvite(null);
                            }}
                            className={cn(
                              "flex-1 h-10 border border-border rounded-lg items-center justify-center",
                              processingInvite?.id === inv.id && "opacity-50"
                            )}
                          >
                            {isDeclining ? (
                              <ActivityIndicator size="small" />
                            ) : (
                              <Text className="text-sm font-medium text-foreground">
                                {expired ? "Dismiss" : "Decline"}
                              </Text>
                            )}
                          </Pressable>
                        </View>
                      </View>
                    );
                  })}
                </CardContent>
              </Card>
            )}
          </View>

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
                    <Pressable
                      onPress={() => setShowInviteModal(true)}
                      className="flex-row items-center gap-1.5 mt-2 px-4 py-2 border border-border rounded-lg"
                    >
                      <UserPlus size={14} className="text-foreground" />
                      <Text className="text-sm font-medium text-foreground">
                        Invite members
                      </Text>
                    </Pressable>
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

      {/* Invite Members Modal */}
      <InviteMembersModal
        visible={showInviteModal}
        onClose={() => {
          setShowInviteModal(false);
          loadPeopleData();
        }}
        workspaceId={resolvedWs?.id || currentWorkspace?.id || ""}
        workspaceName={resolvedWs?.name || currentWorkspace?.name || ""}
        actions={actions}
      />

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

      <MemberDetailSheet
        visible={selectedMember !== null}
        profile={
          selectedMember
            ? {
                name: describeMember(selectedMember).name,
                email: describeMember(selectedMember).email,
                role: selectedMember.role,
              }
            : null
        }
        member={selectedMemberInsight}
        canSeeUsage={selectedMember ? canSeeUsageFor(selectedMember) : false}
        loading={isLoadingMemberInsight}
        period={memberUsagePeriod}
        onPeriodChange={handleMemberUsagePeriodChange}
        onClose={closeDetailSheet}
        access={
          selectedMember ? (
            <MemberAccessSection
              memberName={describeMember(selectedMember).name}
              role={selectedMember.role}
              isSelf={selectedMember.userId === user?.id}
              viewerRole={viewerRole}
              workspaceCount={workspaceCount}
              otherOwnerCount={otherOwnerCount}
              onChangeRole={(role) =>
                void handleChangeRole(selectedMember, role)
              }
              onRemove={() => requestRemove(selectedMember)}
              onLeave={requestLeave}
            />
          ) : null
        }
      />

      <RemoveMemberDialog
        target={removeTarget}
        workspaceName={workspaceName}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={confirmRemoveMember}
      />

      <LeaveWorkspaceDialog
        visible={isLeaveDialogOpen}
        workspaceId={resolvedWs?.id || currentWorkspace?.id}
        workspaceName={workspaceName}
        onClose={() => setIsLeaveDialogOpen(false)}
      />
    </View>
  );
});
