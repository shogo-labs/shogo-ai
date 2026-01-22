/**
 * AdvancedChatLayout - Project-scoped advanced chat view
 *
 * Uses ComposablePhaseView pattern with a "workspace" Composition entity.
 * Virtual tools (like show_schema) modify the Composition's slotContent,
 * and MobX reactivity triggers re-render via observer().
 *
 * This layout is accessible via Cmd+Shift+A from ProjectLayout and provides
 * a different UX focused on dynamic UI composition via virtual tools.
 *
 * Layout: ComposablePhaseView (LEFT) + ChatPanel (RIGHT)
 * vs ProjectLayout: ChatPanel (LEFT) + Preview (RIGHT)
 *
 * Task: task-testbed-layout, req-wpp-layout-refactor
 * Feature: virtual-tools-domain
 */

import { observer } from "mobx-react-lite";
import { useEffect, useCallback, useState, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useDomains } from "@/contexts/DomainProvider";
import { ComposablePhaseView } from "../../rendering/composition/ComposablePhaseView";
import { ComponentRegistryProvider } from "@/components/rendering";
import { createRegistryFromDomain } from "@/components/rendering/registryFactory";
import { ChatPanel } from "../chat/ChatPanel";
import {
  ChatSessionPicker,
  type ChatSession,
} from "../chat/ChatSessionPicker";
import { useChatSessionNavigation } from "./hooks/useChatSessionNavigation";
import { useWorkspaceNavigation } from "../workspace/hooks/useWorkspaceNavigation";
import { cn } from "@/lib/utils";
import { useSession } from "@/auth/client";

// ============================================================
// Constants
// ============================================================

const WORKSPACE_COMPOSITION_NAME = "workspace";

// ============================================================
// Component
// ============================================================

export const AdvancedChatLayout = observer(function AdvancedChatLayout() {
  // Get projectId from URL params (route: /projects/:projectId/advanced-chat)
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { data: session } = useSession();

  const { componentBuilder, studioChat, studioCore } = useDomains<{
    componentBuilder: any;
    studioChat: any;
    studioCore: any;
  }>();

  // Track current chat session in URL (persists across refresh/hot reload)
  const { chatSessionId, setChatSessionId } = useChatSessionNavigation();

  // Register workspace params with nuqs so they're preserved during navigation
  useWorkspaceNavigation();

  // Lift chat panel collapse state to parent to control layout
  const [isChatCollapsed, setIsChatCollapsed] = useState(false);

  // Lift chat panel width to parent for proper layout control
  const [chatWidth, setChatWidth] = useState(400);

  // Project state (loaded async)
  const [project, setProject] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Create component registry from domain (same pattern as ProjectLayout)
  const prevBindingsKeyRef = useRef<string>("");
  const registryRef = useRef<ReturnType<typeof createRegistryFromDomain> | null>(null);

  const bindings = componentBuilder?.rendererBindingCollection?.all() ?? [];
  const currentBindingsKey = bindings
    .map((b: any) => `${b.id}:${b.updatedAt ?? ""}`)
    .join("|");

  if (currentBindingsKey !== prevBindingsKeyRef.current || !registryRef.current) {
    prevBindingsKeyRef.current = currentBindingsKey;
    registryRef.current = createRegistryFromDomain(componentBuilder);
  }

  const registry = registryRef.current;

  // Check if domains are ready
  const domainsReady = !!studioCore?.projectCollection;

  // Load project data
  useEffect(() => {
    if (!projectId || !domainsReady) {
      return;
    }

    let cancelled = false;
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 500;

    const loadProject = async (attempt = 1): Promise<void> => {
      if (cancelled) return;

      try {
        const proj = await studioCore.projectCollection
          .query()
          .where({ id: projectId })
          .first();

        if (cancelled) return;

        if (proj) {
          setProject(proj);
          setIsLoading(false);
        } else {
          console.warn("[AdvancedChatLayout] Project not found:", projectId);
          setIsLoading(false);
        }
      } catch (err: any) {
        if (cancelled) return;

        // Retry if schema not loaded yet (race condition on page refresh)
        const isSchemaNotLoaded =
          err?.message?.includes("Schema") || err?.message?.includes("SCHEMA_NOT_FOUND");
        if (isSchemaNotLoaded && attempt < MAX_RETRIES) {
          console.debug(
            `[AdvancedChatLayout] Schema not ready, retrying (${attempt}/${MAX_RETRIES})...`
          );
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
          return loadProject(attempt + 1);
        }

        console.error("[AdvancedChatLayout] Failed to load project:", err);
        setIsLoading(false);
      }
    };

    loadProject();

    return () => {
      cancelled = true;
    };
  }, [projectId, domainsReady, studioCore]);

  // Keyboard shortcut: Cmd+Shift+A to toggle back to normal project view
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        // Preserve chatSessionId in URL when switching
        const params = chatSessionId ? `?chatSessionId=${chatSessionId}` : "";
        navigate(`/projects/${projectId}${params}`);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigate, projectId, chatSessionId]);

  // Get workspace composition (for observability - triggers re-render when modified)
  const workspaceComposition =
    componentBuilder?.compositionCollection?.findByName?.(
      WORKSPACE_COMPOSITION_NAME
    );

  // Get all chat sessions for this project
  const projectChatSessions: ChatSession[] = projectId
    ? (studioChat?.chatSessionCollection?.findByContext?.(projectId) ?? []).map(
        (s: any) => ({
          id: s.id,
          name: s.name || s.inferredName,
          messageCount: s.messageCount ?? 0,
          updatedAt: s.lastActiveAt,
        })
      )
    : [];

  // Handler for session selection
  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      await setChatSessionId(sessionId);
    },
    [setChatSessionId]
  );

  // Handler for creating a new session
  const handleCreateSession = useCallback(async () => {
    if (!studioChat || !projectId) return;
    const newSession = await studioChat.createChatSession({
      inferredName: `Chat ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
      contextType: "project",
      contextId: projectId,
    });
    await setChatSessionId(newSession.id);
  }, [studioChat, projectId, setChatSessionId]);

  // Sync from ChatPanel when it auto-creates a session
  const handleChatSessionChange = useCallback(
    async (sessionId: string) => {
      await setChatSessionId(sessionId);
    },
    [setChatSessionId]
  );

  // Handler for renaming a session
  const handleRenameSession = useCallback(
    async (sessionId: string, newName: string) => {
      if (!studioChat?.chatSessionCollection) return;
      await studioChat.chatSessionCollection.updateOne(sessionId, {
        name: newName,
      });
    },
    [studioChat]
  );

  // Get workspace ID for credit tracking
  const workspaceId = project
    ? typeof project.workspace === "string"
      ? project.workspace
      : project.workspace?.id
    : null;

  // Guard: No projectId in URL
  if (!projectId) {
    return (
      <div className="h-screen flex items-center justify-center text-muted-foreground">
        No project selected. Navigate from a project to access Advanced Chat.
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <ComponentRegistryProvider registry={registry}>
        <div className="h-screen flex items-center justify-center">
          <div className="text-muted-foreground animate-pulse">
            Loading workspace...
          </div>
        </div>
      </ComponentRegistryProvider>
    );
  }

  // Project not found
  if (!project) {
    return (
      <ComponentRegistryProvider registry={registry}>
        <div className="h-screen flex items-center justify-center text-muted-foreground">
          Project not found.
        </div>
      </ComponentRegistryProvider>
    );
  }

  return (
    <ComponentRegistryProvider registry={registry}>
      <div className="h-screen flex">
        {/* Dynamic Workspace - ComposablePhaseView renders the workspace Composition */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <ComposablePhaseView
            phaseName={WORKSPACE_COMPOSITION_NAME}
            feature={project}
            className="h-full"
          />
        </div>

        {/* Chat Panel Container - dynamic width controlled by ChatPanel resize */}
        <div
          className={cn(
            "border-l flex-shrink-0 flex flex-col transition-all duration-200",
            isChatCollapsed && "w-16"
          )}
          style={!isChatCollapsed ? { width: `${chatWidth}px` } : undefined}
        >
          {/* Session Picker Header - hide when collapsed */}
          {!isChatCollapsed && (
            <div className="px-3 py-2 border-b flex items-center justify-between bg-muted/30">
              <span className="text-sm font-medium text-muted-foreground">
                Chat Sessions
              </span>
              <ChatSessionPicker
                sessions={projectChatSessions}
                currentSessionId={chatSessionId ?? undefined}
                onSelect={handleSelectSession}
                onCreate={handleCreateSession}
                onRename={handleRenameSession}
              />
            </div>
          )}

          {/* Chat Panel */}
          <div className="flex-1 min-h-0">
            <ChatPanel
              featureId={null}
              featureName={project.name}
              phase={null}
              projectId={projectId}
              chatSessionId={chatSessionId}
              onChatSessionChange={handleChatSessionChange}
              isCollapsed={isChatCollapsed}
              onCollapsedChange={setIsChatCollapsed}
              onWidthChange={setChatWidth}
              workspaceId={workspaceId}
              userId={session?.user?.id}
              useMainChatEndpoint
            />
          </div>
        </div>
      </div>
    </ComponentRegistryProvider>
  );
});
