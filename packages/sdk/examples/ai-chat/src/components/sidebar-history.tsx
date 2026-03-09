// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { isToday, isYesterday, subMonths, subWeeks } from "date-fns";
import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  useSidebar,
} from "@/components/ui/sidebar";
import { LoaderIcon } from "./icons";
import { ChatItem } from "./sidebar-history-item";
import { toast } from "sonner";

interface Chat {
  id: string;
  title: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

type GroupedChats = {
  today: Chat[];
  yesterday: Chat[];
  lastWeek: Chat[];
  lastMonth: Chat[];
  older: Chat[];
};

const groupChatsByDate = (chats: Chat[]): GroupedChats => {
  const now = new Date();
  const oneWeekAgo = subWeeks(now, 1);
  const oneMonthAgo = subMonths(now, 1);

  return chats.reduce(
    (groups, chat) => {
      const chatDate = new Date(chat.createdAt);

      if (isToday(chatDate)) {
        groups.today.push(chat);
      } else if (isYesterday(chatDate)) {
        groups.yesterday.push(chat);
      } else if (chatDate > oneWeekAgo) {
        groups.lastWeek.push(chat);
      } else if (chatDate > oneMonthAgo) {
        groups.lastMonth.push(chat);
      } else {
        groups.older.push(chat);
      }

      return groups;
    },
    {
      today: [],
      yesterday: [],
      lastWeek: [],
      lastMonth: [],
      older: [],
    } as GroupedChats
  );
};

export function SidebarHistory({
  userId,
  currentChatId,
  onSelectChat,
  onDeleteChat,
  refreshKey,
}: {
  userId: string;
  currentChatId: string | null;
  onSelectChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  refreshKey: number;
}) {
  const { setOpenMobile } = useSidebar();
  const [chats, setChats] = useState<Chat[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  useEffect(() => {
    const fetchChats = async () => {
      try {
        const response = await fetch(`/api/chats?userId=${userId}`);
        if (response.ok) {
          const data = await response.json();
          const sortedChats = (data.items || data || []).sort(
            (a: Chat, b: Chat) =>
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          );
          setChats(sortedChats);
        }
      } catch (error) {
        console.error("Failed to fetch chats:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchChats();
  }, [userId, refreshKey]);

  const handleDelete = async () => {
    if (!deleteId) return;
    setShowDeleteDialog(false);

    try {
      await fetch(`/api/chats/${deleteId}`, { method: "DELETE" });
      setChats((prev) => prev.filter((c) => c.id !== deleteId));
      onDeleteChat(deleteId);
      toast.success("Chat deleted successfully");
    } catch {
      toast.error("Failed to delete chat");
    }
  };

  if (isLoading) {
    return (
      <SidebarGroup>
        <div className="px-2 py-1 text-sidebar-foreground/50 text-xs">
          Today
        </div>
        <SidebarGroupContent>
          <div className="flex flex-col">
            {[44, 32, 28, 64, 52].map((item) => (
              <div
                className="flex h-8 items-center gap-2 rounded-md px-2"
                key={item}
              >
                <div
                  className="h-4 flex-1 rounded-md bg-sidebar-accent-foreground/10"
                  style={{ maxWidth: `${item}%` }}
                />
              </div>
            ))}
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  if (chats.length === 0) {
    return (
      <SidebarGroup>
        <SidebarGroupContent>
          <div className="flex w-full flex-row items-center justify-center gap-2 px-2 text-sm text-zinc-500">
            Your conversations will appear here once you start chatting!
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  const groupedChats = groupChatsByDate(chats);

  const renderGroup = (label: string, groupChats: Chat[]) => {
    if (groupChats.length === 0) return null;
    return (
      <div key={label}>
        <div className="px-2 py-1 text-sidebar-foreground/50 text-xs">
          {label}
        </div>
        {groupChats.map((chat) => (
          <ChatItem
            chat={chat}
            isActive={chat.id === currentChatId}
            key={chat.id}
            onDelete={(chatId) => {
              setDeleteId(chatId);
              setShowDeleteDialog(true);
            }}
            onSelect={onSelectChat}
            setOpenMobile={setOpenMobile}
          />
        ))}
      </div>
    );
  };

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <div className="flex flex-col gap-6">
              {renderGroup("Today", groupedChats.today)}
              {renderGroup("Yesterday", groupedChats.yesterday)}
              {renderGroup("Last 7 days", groupedChats.lastWeek)}
              {renderGroup("Last 30 days", groupedChats.lastMonth)}
              {renderGroup("Older", groupedChats.older)}
            </div>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <AlertDialog onOpenChange={setShowDeleteDialog} open={showDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete your
              chat and remove it from our servers.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
