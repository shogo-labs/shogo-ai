// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The chat list every sidebar renders: project chats under a project row and
 * the workspace agent's chats on Home. Presentation only — the caller owns the
 * fetch, the ordering (see `sortSideChats` / `visibleProjectChatItems`) and what
 * a row action does. Paging, the Archived subsection and the delete
 * confirmation live here so both lists behave the same by construction.
 *
 * Two paging modes: `inline` (the default — 5 rows, +10 per "Show more", capped
 * at 20, then "See all"), and `infinite`, where the list grows 30 rows at a
 * time as the panel's scroll view nears its end and draws no paging rows at all.
 */
import { useCallback, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { projectChatLabel } from "../../../lib/project-chat-sessions";
import { ChatTreeItem } from "./ChatTreeItem";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { useSidebarScrollEnd } from "./SidebarScrollContext";

export const INITIAL_VISIBLE_CHATS = 5;
export const INLINE_CHAT_INCREMENT = 10;
export const MAX_INLINE_CHATS = 20;
/** Rows added per scroll-end in `paging="infinite"`. */
export const INFINITE_CHAT_PAGE = 30;
const ARCHIVED_CHAT_ROW_ID = "archived-chats" as const;

export type ChatSessionListPaging = "inline" | "infinite";

export type ChatSessionListHeaderAction = {
  label: string;
  accessibilityLabel: string;
  icon: ReactNode;
  onPress: () => void;
  /** Show a spinner and ignore presses while the chat is being created. */
  busy?: boolean;
};

type SidebarChatRow =
  | { type: "chat"; id: string; session: any }
  | { type: "archived-header"; id: typeof ARCHIVED_CHAT_ROW_ID }
  | {
      type: "footer";
      id: string;
      action: "show-more" | "show-less" | "see-all";
      count: number;
      scope: "active" | "archived";
    };

/**
 * One secondary row — "Show more", "See all (12)", the Archived toggle, the
 * caller's header action. Kept as a single primitive so those affordances can
 * never drift apart between the two lists.
 */
function ChatListRow({
  label,
  accessibilityLabel,
  icon,
  onPress,
  ariaExpanded,
  trailingText,
  indent,
}: {
  label: string;
  accessibilityLabel: string;
  icon: ReactNode;
  onPress: () => void;
  ariaExpanded?: boolean;
  trailingText?: string | number;
  indent?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      role="button"
      accessibilityLabel={accessibilityLabel}
      aria-expanded={ariaExpanded}
      className={cn(
        "flex-row items-center gap-1 pt-2 pb-0.5 active:opacity-70",
        indent ? "pl-12 pr-1" : "px-1",
      )}
    >
      {icon}
      <Text
        className="text-[10px] uppercase tracking-wide text-muted-foreground flex-1"
        numberOfLines={1}
      >
        {label}
      </Text>
      {trailingText === undefined ? null : (
        <Text className="text-[10px] text-muted-foreground shrink-0">
          {trailingText}
        </Text>
      )}
    </Pressable>
  );
}

function createSidebarChatRows(
  activeSessions: any[],
  archivedSessions: any[],
  archivedExpanded: boolean,
  {
    activeHasMore,
    activeShownCount,
    archivedHasMore,
    archivedShownCount,
    archivedTotal,
    includeFooter,
    hasMoreChats,
    totalChats,
  }: {
    activeHasMore: boolean;
    activeShownCount: number;
    archivedHasMore: boolean;
    archivedShownCount: number;
    archivedTotal: number;
    includeFooter: boolean;
    hasMoreChats: boolean;
    totalChats: number;
  },
): SidebarChatRow[] {
  const rows: SidebarChatRow[] = activeSessions.map((session: any) => ({
    type: "chat",
    id: session.id,
    session,
  }));

  if (includeFooter) {
    if (activeHasMore) {
      rows.push({
        type: "footer",
        id: "active-chats-footer",
        action:
          hasMoreChats || activeShownCount >= MAX_INLINE_CHATS
            ? "see-all"
            : "show-more",
        count: Math.max(totalChats, activeSessions.length),
        scope: "active",
      });
    } else if (activeShownCount > INITIAL_VISIBLE_CHATS) {
      rows.push({
        type: "footer",
        id: "active-chats-footer",
        action: "show-less",
        count: Math.max(totalChats, activeSessions.length),
        scope: "active",
      });
    }
  }

  if (archivedTotal > 0) {
    rows.push({ type: "archived-header", id: ARCHIVED_CHAT_ROW_ID });
  }

  if (archivedExpanded) {
    rows.push(
      ...archivedSessions.map((session: any) => ({
        type: "chat" as const,
        id: session.id,
        session,
      })),
    );

    if (includeFooter) {
      if (archivedHasMore) {
        rows.push({
          type: "footer",
          id: "archived-chats-footer",
          action:
            hasMoreChats || archivedShownCount >= MAX_INLINE_CHATS
              ? "see-all"
              : "show-more",
          count: Math.max(totalChats, archivedSessions.length),
          scope: "archived",
        });
      } else if (archivedShownCount > INITIAL_VISIBLE_CHATS) {
        rows.push({
          type: "footer",
          id: "archived-chats-footer",
          action: "show-less",
          count: Math.max(totalChats, archivedSessions.length),
          scope: "archived",
        });
      }
    }
  }

  return rows;
}

export function ChatSessionList({
  sessions,
  archivedSessions,
  activeChatId,
  streamingIds,
  completedIds,
  variant,
  mobileProjectDetail,
  renderAll = false,
  paging = "inline",
  loaded = true,
  emptyLabel,
  loadingLabel = "Loading…",
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  onSeeAll,
  headerAction,
  onSelect,
  onTogglePin,
  onRename,
  onToggleArchive,
  onDeleteChat,
  revealActiveChat,
  totalCount,
  scopeLabel,
  listAccessibilityLabel,
  testID,
  rowClassName,
  textClassName,
  inactiveTextClassName,
}: {
  /** Active rows, already ordered (and already filtered of archived ones). */
  sessions: any[];
  /** Archived rows, already ordered. */
  archivedSessions?: any[];
  activeChatId?: string | null;
  streamingIds?: Set<string>;
  completedIds?: Set<string>;
  variant?: "workspacePane";
  mobileProjectDetail?: boolean;
  /**
   * Render every chat instead of the 5 / +10 / 20 inline page. For a caller with
   * its own scroll view (the phone drawer's Chats section), where the paging
   * rows only hide chats behind a "Show more" tap — and past 20 behind a "See
   * all" row that has nowhere to go when the caller passes no `onSeeAll`.
   */
  renderAll?: boolean;
  /**
   * `inline` (default) pages with "Show more" / "Show less" / "See all".
   * `infinite` draws no paging rows and grows `INFINITE_CHAT_PAGE` rows at a
   * time as the sidebar panel nears its end; with no `SidebarScrollView` above
   * it, it renders every chat instead of hiding rows behind a trigger that
   * can't fire.
   */
  paging?: ChatSessionListPaging;
  loaded?: boolean;
  /** Copy shown when there are no chats at all. */
  emptyLabel: string;
  loadingLabel?: string;
  /** The server has older chats than the ones loaded (project paging). */
  hasMore?: boolean;
  loadingMore?: boolean;
  /** Called when the detail list scrolls to the end and `hasMore`. */
  onLoadMore?: () => void;
  /** Omitted → the footer's "See all (n)" row is not offered. */
  onSeeAll?: () => void;
  headerAction?: ChatSessionListHeaderAction;
  onSelect: (sessionId: string) => void;
  onTogglePin: (sessionId: string, next: boolean) => void;
  onRename: (sessionId: string, name: string) => void;
  onToggleArchive: (sessionId: string, next: boolean) => void;
  onDeleteChat: (sessionId: string) => void | Promise<void>;
  /** Keep the open chat visible even when it falls outside the first page. */
  revealActiveChat?: boolean;
  /** Total chats behind the list, for the "See all (n)" count. */
  totalCount?: number;
  /** Row-owner name used in the paging rows' accessibility labels. */
  scopeLabel?: string;
  listAccessibilityLabel?: string;
  testID?: string;
  /** Row/label overrides for callers that do not want the phone density. */
  rowClassName?: string;
  textClassName?: string;
  inactiveTextClassName?: string;
}) {
  const archived = archivedSessions ?? [];
  const infinite = paging === "infinite";
  const firstPage = infinite ? INFINITE_CHAT_PAGE : INITIAL_VISIBLE_CHATS;
  // One state for both subsections so a scroll-end can decide between them
  // (active first, archived once active is exhausted) without reading the
  // other updater's pending value.
  const [page, setPage] = useState({
    active: firstPage,
    archived: firstPage,
  });
  const visibleCount = page.active;
  const archivedVisibleCount = page.archived;
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    label: string;
  } | null>(null);

  const handleShowMore = useCallback((scope: "active" | "archived") => {
    setPage((current) => ({
      ...current,
      [scope]: Math.min(current[scope] + INLINE_CHAT_INCREMENT, MAX_INLINE_CHATS),
    }));
  }, []);

  const handleShowLess = useCallback((scope: "active" | "archived") => {
    setPage((current) => ({ ...current, [scope]: INITIAL_VISIBLE_CHATS }));
  }, []);

  const toggleArchived = useCallback(() => {
    // Re-expanding starts at the first page in infinite mode (there is no
    // "Show less" to undo a long scroll); inline keeps the page it had, as on
    // main.
    if (archivedExpanded && infinite) {
      setPage((current) => ({ ...current, archived: firstPage }));
    }
    setArchivedExpanded((value) => !value);
  }, [archivedExpanded, firstPage, infinite]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!hasMore || loadingMore) return;
      const { contentOffset, contentSize, layoutMeasurement } =
        event.nativeEvent;
      const distanceFromBottom =
        contentSize.height - (contentOffset.y + layoutMeasurement.height);
      if (distanceFromBottom <= 24) onLoadMore?.();
    },
    [hasMore, loadingMore, onLoadMore],
  );

  // Infinite mode: each "near the end" grows the active rows first and, once
  // those are all drawn, the archived rows (when the subsection is open).
  const growInfinitePage = useCallback(() => {
    setPage((current) => {
      if (current.active < sessions.length) {
        return {
          ...current,
          active: Math.min(current.active + INFINITE_CHAT_PAGE, sessions.length),
        };
      }
      if (archivedExpanded && current.archived < archived.length) {
        return {
          ...current,
          archived: Math.min(
            current.archived + INFINITE_CHAT_PAGE,
            archived.length,
          ),
        };
      }
      return current;
    });
    if (hasMore && !loadingMore) onLoadMore?.();
  }, [
    sessions.length,
    archived.length,
    archivedExpanded,
    hasMore,
    loadingMore,
    onLoadMore,
  ]);

  const infinitePaging = infinite && !mobileProjectDetail && !renderAll;
  const hasScrollSignal = useSidebarScrollEnd(growInfinitePage, infinitePaging);
  // No paging rows to press and no scroll signal to grow on: draw every row.
  const renderEverything =
    mobileProjectDetail || renderAll || (infinitePaging && !hasScrollSignal);

  const activeSessionsForList = renderEverything
    ? [...sessions]
    : sessions.slice(0, visibleCount);
  if (revealActiveChat && !mobileProjectDetail && activeChatId) {
    const activeSession = sessions.find(
      (session) => session.id === activeChatId,
    );
    if (
      activeSession &&
      !activeSessionsForList.some((session) => session.id === activeChatId)
    ) {
      activeSessionsForList.push(activeSession);
    }
  }
  const archivedSessionsForList = renderEverything
    ? [...archived]
    : archivedExpanded
      ? archived.slice(0, archivedVisibleCount)
      : [];

  const renderChat = (session: any, key = session.id) => (
    <ChatTreeItem
      key={key}
      session={session}
      active={!!activeChatId && session.id === activeChatId}
      isStreaming={streamingIds?.has(session.id) ?? false}
      isCompleted={completedIds?.has(session.id) ?? false}
      onSelect={onSelect}
      onTogglePin={onTogglePin}
      onRename={onRename}
      onToggleArchive={onToggleArchive}
      onRequestDelete={(id) =>
        setDeleteTarget({ id, label: projectChatLabel(session) })
      }
      mobileProjectDetail={mobileProjectDetail}
      variant={variant}
      rowClassName={rowClassName}
      textClassName={textClassName}
      inactiveTextClassName={inactiveTextClassName}
    />
  );

  const chatRows = createSidebarChatRows(
    activeSessionsForList,
    archivedSessionsForList,
    archivedExpanded,
    {
      activeHasMore:
        !mobileProjectDetail &&
        !renderAll &&
        (sessions.length > visibleCount || hasMore),
      activeShownCount: mobileProjectDetail ? sessions.length : visibleCount,
      archivedHasMore:
        !mobileProjectDetail &&
        !renderAll &&
        archivedExpanded &&
        (archived.length > archivedVisibleCount || hasMore),
      archivedTotal: archived.length,
      archivedShownCount: mobileProjectDetail
        ? archived.length
        : archivedVisibleCount,
      includeFooter: paging === "inline" && !mobileProjectDetail && !renderAll,
      hasMoreChats: hasMore,
      totalChats: Math.max(totalCount ?? sessions.length, sessions.length),
    },
  );

  const forScope = (label: string) =>
    scopeLabel ? `${label} ${scopeLabel}` : label;

  const rowContent = chatRows.map((row) => {
    if (row.type === "chat") return renderChat(row.session, row.id);
    if (row.type === "footer") {
      return (
        <ChatListRow
          key={row.id}
          label={
            row.action === "show-more"
              ? "Show more"
              : row.action === "show-less"
                ? "Show less"
                : `See all (${row.count})`
          }
          accessibilityLabel={
            row.action === "show-more"
              ? forScope("Show more chats for")
              : row.action === "show-less"
                ? forScope("Show fewer chats for")
                : forScope("See all chats for")
          }
          indent={mobileProjectDetail}
          icon={
            row.action === "see-all" ? (
              <ChevronRight
                size={10}
                className="text-muted-foreground shrink-0"
              />
            ) : (
              <ChevronDown
                size={10}
                className={cn(
                  "text-muted-foreground shrink-0",
                  row.action === "show-less" && "rotate-180",
                )}
              />
            )
          }
          onPress={() => {
            if (row.action === "show-more") handleShowMore(row.scope);
            else if (row.action === "show-less") handleShowLess(row.scope);
            else if (onSeeAll) onSeeAll();
            else handleShowMore(row.scope);
          }}
        />
      );
    }
    return (
      <ChatListRow
        key={row.id}
        label="Archived"
        accessibilityLabel={`${archivedExpanded ? "Collapse" : "Expand"} archived chats`}
        aria-expanded={archivedExpanded}
        trailingText={archived.length}
        indent={mobileProjectDetail}
        icon={
          archivedExpanded ? (
            <ChevronDown
              size={10}
              className="text-muted-foreground shrink-0"
            />
          ) : (
            <ChevronRight
              size={10}
              className="text-muted-foreground shrink-0"
            />
          )
        }
        onPress={toggleArchived}
      />
    );
  });

  const loadingMoreContent = loadingMore ? (
    <View className="px-2 py-1.5">
      <Text
        className="text-xs text-muted-foreground opacity-70"
        numberOfLines={1}
      >
        Loading more…
      </Text>
    </View>
  ) : null;

  return (
    <View
      testID={testID}
      className={cn(
        mobileProjectDetail
          ? "flex-1"
          : variant === "workspacePane"
            ? "mt-0.5"
            : "ml-6 mt-0.5",
      )}
    >
      {headerAction ? (
        <ChatListRow
          label={headerAction.label}
          accessibilityLabel={headerAction.accessibilityLabel}
          icon={
            headerAction.busy ? (
              <ActivityIndicator size="small" />
            ) : (
              headerAction.icon
            )
          }
          onPress={() => {
            if (!headerAction.busy) headerAction.onPress();
          }}
        />
      ) : null}
      {sessions.length === 0 && archived.length === 0 ? (
        <View
          className={mobileProjectDetail ? "pl-12 pr-2 py-3" : "px-2 py-3"}
        >
          <Text
            className="text-sm text-muted-foreground opacity-70"
            numberOfLines={1}
          >
            {loaded ? emptyLabel : loadingLabel}
          </Text>
        </View>
      ) : mobileProjectDetail ? (
        <ScrollView
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator
          accessibilityLabel={listAccessibilityLabel}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingRight: 2 }}
          onScroll={handleScroll}
          scrollEventThrottle={64}
        >
          {rowContent}
          {loadingMoreContent}
        </ScrollView>
      ) : (
        <View accessibilityLabel={listAccessibilityLabel} role="list">
          {rowContent}
        </View>
      )}
      <ConfirmDeleteDialog
        visible={!!deleteTarget}
        title="Delete chat"
        message={`Permanently delete "${deleteTarget?.label}"? This can't be undone.`}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target) void onDeleteChat(target.id);
        }}
      />
    </View>
  );
}
