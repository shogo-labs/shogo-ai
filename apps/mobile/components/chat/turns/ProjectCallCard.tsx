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
import { ChatMarkdown } from "../ChatMarkdown";
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
  running: boolean;
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
    running: result.status === "running",
    queued: result.status === "accepted" || result.wait === false || args.wait === false,
    deliverables,
  };
}

type CallStatus = "calling" | "queued" | "replied" | "failed";

function statusOf(tool: ToolCallData, view: ProjectCallView): CallStatus {
  if (view.error || tool.state === "error") return "failed";
  if (view.queued) return "queued";
  if (view.running) return "calling";
  if (tool.state === "streaming") return view.queued ? "queued" : "calling";
  return "replied";
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

/**
 * Collapsed heights of the card's markdown bodies: a whole number of card body
 * lines (12/18 in `global.css` and `MarkdownText`'s card styles). A height that
 * is not a multiple of 18 leaves the last visible line a chopped row of glyphs.
 */
const CARD_LINE_HEIGHT = 18;
export const REQUEST_MAX_HEIGHT = 2 * CARD_LINE_HEIGHT;
export const REPLY_MAX_HEIGHT = 4 * CARD_LINE_HEIGHT;

const LONG_BODY_CHARS = 220;

/**
 * Raw-text fallback for "this body cannot fit the clamped preview". Rendered
 * height is measured too (markdown has no `numberOfLines`), but the heuristic
 * keeps long single-line bodies expandable before the first layout pass.
 */
export function bodyOverflowsPreview(text: string, maxLines: number): boolean {
  return text.length > LONG_BODY_CHARS || text.split("\n").length > maxLines;
}

/**
 * Markdown has no `numberOfLines`, so the preview is clamped by height. The
 * inner view measures the full body, which is how the card knows to offer
 * "Show more" even when the raw text is short enough to pass the heuristic.
 */
function ClampedMarkdown({
  text,
  maxHeight,
  expanded,
  onMeasure,
  onFilePress,
  fileExists,
  testID,
}: {
  text: string;
  maxHeight: number;
  expanded: boolean;
  onMeasure: (height: number) => void;
  onFilePress?: (path: string) => void;
  fileExists?: (path: string) => boolean;
  testID: string;
}) {
  return (
    <View
      style={expanded ? undefined : { maxHeight, overflow: "hidden" }}
      testID={`${testID}-clamp`}
    >
      <View
        testID={`${testID}-body`}
        onLayout={(event) => onMeasure(event.nativeEvent.layout.height)}
      >
        <ChatMarkdown
          isStreaming={false}
          variant="card"
          onFilePress={onFilePress}
          fileExists={fileExists}
        >
          {text}
        </ChatMarkdown>
      </View>
    </View>
  );
}

function ExpandToggle({ expanded, onPress }: { expanded: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      <Text className="text-[11px] text-primary">{expanded ? "Show less" : "Show more"}</Text>
    </Pressable>
  );
}

export function ProjectCallCard({ tool, className }: ProjectCallCardProps) {
  const router = useRouter();
  const chatContext = useChatContextSafe();
  const openPane = chatContext?.openProjectPane;
  const [elapsed, setElapsed] = useState(0);
  const [requestExpanded, setRequestExpanded] = useState(false);
  const [replyExpanded, setReplyExpanded] = useState(false);
  const [errorExpanded, setErrorExpanded] = useState(false);
  const [requestHeight, setRequestHeight] = useState(0);
  const [replyHeight, setReplyHeight] = useState(0);

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
  const requestOverflows =
    requestHeight > REQUEST_MAX_HEIGHT || bodyOverflowsPreview(view.message, 2);
  const replyOverflows =
    !!view.reply && (replyHeight > REPLY_MAX_HEIGHT || bodyOverflowsPreview(view.reply, 4));

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
          <View className="gap-0.5" testID="project-call-request">
            <Text className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">Request</Text>
            <ClampedMarkdown
              text={view.message}
              maxHeight={REQUEST_MAX_HEIGHT}
              expanded={requestExpanded}
              onMeasure={(height) => setRequestHeight((prev) => (prev === height ? prev : height))}
              onFilePress={chatContext?.openFile}
              fileExists={chatContext?.fileExists}
              testID="project-call-request"
            />
            {requestOverflows ? (
              <ExpandToggle expanded={requestExpanded} onPress={() => setRequestExpanded((v) => !v)} />
            ) : null}
          </View>
        ) : null}

        {view.error ? (
          <View className="gap-0.5">
            <Text className="text-[9px] font-medium uppercase tracking-wide text-destructive">Error</Text>
            <Text
              className="text-[11px] text-destructive"
              numberOfLines={errorExpanded ? undefined : 4}
              selectable
              testID="project-call-error"
            >
              {view.error}
            </Text>
            {bodyOverflowsPreview(view.error, 4) ? (
              <ExpandToggle expanded={errorExpanded} onPress={() => setErrorExpanded((v) => !v)} />
            ) : null}
          </View>
        ) : view.reply ? (
          <View className="gap-0.5" testID="project-call-reply">
            <Text className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">Reply</Text>
            <ClampedMarkdown
              text={view.reply}
              maxHeight={REPLY_MAX_HEIGHT}
              expanded={replyExpanded}
              onMeasure={(height) => setReplyHeight((prev) => (prev === height ? prev : height))}
              onFilePress={chatContext?.openFile}
              fileExists={chatContext?.fileExists}
              testID="project-call-reply"
            />
            {replyOverflows ? (
              <ExpandToggle expanded={replyExpanded} onPress={() => setReplyExpanded((v) => !v)} />
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
