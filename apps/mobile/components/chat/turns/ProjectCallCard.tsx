// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ProjectCallCard Component (React Native)
 *
 * Renders a `project_call` tool call: the workspace agent handing a request to
 * another project's agent. Shows who was called, the request, the status and a
 * reply preview, and opens the project (or the exact chat that recorded the
 * call) in the side pane when the host surface provides one, or navigates to
 * the project otherwise.
 */
import { useEffect, useMemo, useState, useCallback } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { cn } from "@shogo/shared-ui/primitives";
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  MessageSquare,
  PanelRight,
  XCircle,
} from "lucide-react-native";
import type { ToolCallData } from "../tools/types";
import { useChatContextSafe } from "../ChatContext";
import { AgentAvatar } from "../../team-chat/AgentAvatar";

export interface ProjectCallCardProps {
  tool: ToolCallData;
  className?: string;
}

export interface ProjectCallDeliverable {
  href: string;
  label?: string;
}

export interface ProjectCallView {
  projectId: string | null;
  projectName: string;
  message: string;
  runId: string | null;
  reply: string | null;
  error: string | null;
  hint: string | null;
  /** API chat that recorded the call; null when it was not persisted. */
  chatSessionId: string | null;
  queued: boolean;
  deliverables: ProjectCallDeliverable[];
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return toObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  if (typeof value !== "object") return {};
  const obj = value as Record<string, unknown>;
  // Agent tool results can arrive wrapped: { details } or { content: [{ text }] }.
  if (obj.details && typeof obj.details === "object") return obj.details as Record<string, unknown>;
  const content = obj.content;
  if (Array.isArray(content) && typeof (content[0] as any)?.text === "string") {
    return toObject((content[0] as any).text);
  }
  if (typeof obj.text === "string" && !("project" in obj) && !("reply" in obj)) {
    return toObject(obj.text);
  }
  return obj;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Runtime-internal session keys (`run:…`, `pipeline`) are not openable chats. */
function openableChatId(v: unknown): string | null {
  const id = str(v);
  if (!id || id.startsWith("run:") || id === "pipeline") return null;
  return id;
}

export function parseProjectCall(tool: ToolCallData): ProjectCallView {
  const args = toObject(tool.args);
  const result = toObject(tool.result);
  const project = (result.project ?? null) as { id?: unknown; name?: unknown } | null;
  const deliverables = Array.isArray(result.deliverables)
    ? (result.deliverables as any[])
        .map((d) => ({ href: str(d?.href) ?? "", label: str(d?.label) ?? undefined }))
        .filter((d) => d.href)
    : [];
  const resultError = str(result.error) ?? (tool.state === "error" ? str(tool.error) : null);
  return {
    projectId: str(project?.id),
    projectName: str(project?.name) ?? str(args.project) ?? "Project",
    message: str(args.message) ?? "",
    runId: str(result.runId) ?? str(args.runId),
    reply: str(result.reply),
    error: resultError,
    hint: str(result.hint),
    chatSessionId: openableChatId(result.chatSessionId),
    queued: result.status === "accepted" || result.wait === false || args.wait === false,
    deliverables,
  };
}

type CallStatus = "calling" | "queued" | "replied" | "failed";

function statusOf(tool: ToolCallData, view: ProjectCallView): CallStatus {
  if (view.error || tool.state === "error") return "failed";
  if (tool.state === "streaming") return view.queued ? "queued" : "calling";
  return view.queued ? "queued" : "replied";
}

function statusLabel(status: CallStatus, elapsedMs: number): string {
  switch (status) {
    case "calling": {
      const secs = Math.floor(elapsedMs / 1000);
      if (secs < 60) return `Calling… ${secs}s`;
      return `Calling… ${Math.floor(secs / 60)}m ${secs % 60}s`;
    }
    case "queued":
      return "Queued";
    case "replied":
      return "Replied";
    case "failed":
      return "Failed";
  }
}

function StatusIcon({ status }: { status: CallStatus }) {
  if (status === "replied") return <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground" size={14} />;
  if (status === "failed") return <XCircle className="w-3.5 h-3.5 text-destructive" size={14} />;
  return <Clock className="w-3.5 h-3.5 text-muted-foreground" size={14} />;
}

export function ProjectCallCard({ tool, className }: ProjectCallCardProps) {
  const router = useRouter();
  const chatContext = useChatContextSafe();
  const openPane = chatContext?.openProjectPane;
  const [elapsed, setElapsed] = useState(0);
  const [replyExpanded, setReplyExpanded] = useState(false);

  const view = useMemo(() => parseProjectCall(tool), [tool.args, tool.result, tool.error, tool.state]);
  const status = statusOf(tool, view);
  const running = status === "calling";

  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    setElapsed(0);
    const interval = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(interval);
  }, [running]);

  const open = useCallback(
    (tab: "chat" | "canvas") => {
      if (!view.projectId) return;
      const chatSessionId = tab === "chat" ? view.chatSessionId ?? undefined : undefined;
      if (openPane) {
        openPane({ projectId: view.projectId, name: view.projectName, chatSessionId, tab });
        return;
      }
      router.push({
        pathname: "/(app)/projects/[id]",
        params: { id: view.projectId, ...(chatSessionId ? { chatSessionId } : {}) },
      } as any);
    },
    [openPane, router, view.chatSessionId, view.projectId, view.projectName],
  );

  const canOpen = !!view.projectId;
  const canOpenChat = canOpen && !!view.chatSessionId;
  const body = view.error ?? view.reply;

  return (
    <View
      className={cn("overflow-hidden rounded-lg border border-border/40 bg-muted/20", className)}
      testID="project-call-card"
    >
      <View className="gap-2 px-3 py-3">
        <View className="flex-row items-center gap-2">
          {view.projectId ? (
            <AgentAvatar name={view.projectName} projectId={view.projectId} workspaceId={chatContext?.workspaceId} size={20} />
          ) : null}
          <Text className="flex-1 text-xs font-semibold text-foreground" numberOfLines={1}>
            {view.projectName}
          </Text>
          {view.runId ? (
            <Text
              className="text-[10px] text-muted-foreground font-mono px-1.5 py-0.5 rounded bg-muted/60"
              numberOfLines={1}
            >
              {view.runId.replace(/^run_/, "").slice(0, 8)}
            </Text>
          ) : null}
          <View className="flex-row items-center gap-1">
            <StatusIcon status={status} />
            <Text
              className={cn("text-[11px]", status === "failed" ? "text-destructive" : "text-muted-foreground")}
              testID="project-call-status"
            >
              {statusLabel(status, elapsed)}
            </Text>
          </View>
        </View>

        {view.message ? (
          <View className="gap-0.5">
            <Text className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">Request</Text>
            <Text className="text-[11px] text-foreground" numberOfLines={2}>
              {view.message}
            </Text>
          </View>
        ) : null}

        {body ? (
          <View className="gap-0.5">
            <Text
              className={cn(
                "text-[9px] font-medium uppercase tracking-wide",
                view.error ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {view.error ? "Error" : "Reply"}
            </Text>
            <Text
              className={cn("text-[11px]", view.error ? "text-destructive" : "text-foreground")}
              numberOfLines={replyExpanded ? undefined : 4}
              selectable
            >
              {body}
            </Text>
            {body.length > 220 || body.split("\n").length > 4 ? (
              <Pressable onPress={() => setReplyExpanded((v) => !v)} accessibilityRole="button">
                <Text className="text-[11px] text-primary">{replyExpanded ? "Show less" : "Show more"}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {view.hint ? <Text className="text-[11px] text-muted-foreground">{view.hint}</Text> : null}

        {view.queued && status === "queued" && !view.error ? (
          <Text className="text-[11px] text-muted-foreground">
            Running in the background. The reply will appear in the project chat.
          </Text>
        ) : null}

        {view.deliverables.length > 0 ? (
          <View className="flex-row flex-wrap gap-1.5">
            {view.deliverables.map((d) => (
              <Pressable
                key={d.href}
                onPress={() => void Linking.openURL(d.href)}
                accessibilityRole="link"
                accessibilityLabel={`Open ${d.href}`}
                className="flex-row items-center gap-1 rounded-full border border-border/60 px-2 py-1 active:bg-muted"
              >
                <ExternalLink size={11} className="text-muted-foreground" />
                <Text className="max-w-[220px] text-[11px] text-foreground" numberOfLines={1}>
                  {d.href.replace(/^https?:\/\//, "")}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <View className="flex-row flex-wrap items-center gap-2 pt-0.5">
          <Pressable
            disabled={!canOpenChat}
            onPress={() => open("chat")}
            accessibilityRole="button"
            accessibilityLabel={`Open chat with ${view.projectName}`}
            className={cn(
              "flex-row items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 active:bg-muted",
              !canOpenChat && "opacity-40",
            )}
          >
            <MessageSquare size={12} className="text-foreground" />
            <Text className="text-[11px] font-medium text-foreground">Open chat</Text>
          </Pressable>
          <Pressable
            disabled={!canOpen}
            onPress={() => open("canvas")}
            accessibilityRole="button"
            accessibilityLabel={`Open project ${view.projectName}`}
            className={cn(
              "flex-row items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 active:bg-muted",
              !canOpen && "opacity-40",
            )}
          >
            <PanelRight size={12} className="text-foreground" />
            <Text className="text-[11px] font-medium text-foreground">Open project</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export default ProjectCallCard;
