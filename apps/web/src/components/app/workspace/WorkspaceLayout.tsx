/**
 * WorkspaceLayout - Simplified workspace layout
 * 
 * Shows the HomePage which has project creation and navigation.
 * Handles template selection by creating a project + chat session,
 * then navigating to the project with an initial AI message.
 *
 * IMPORTANT: Project + chat session creation uses direct API calls instead
 * of domain actions (store.collection.create). This is intentional.
 *
 * Domain actions mutate the MST store synchronously via collection.add(),
 * which triggers MobX observer re-renders in OTHER mounted components
 * (e.g. the sidebar project list). Those observers try to read the newly
 * added node's properties before MST finishes initializing the node,
 * crashing with: "the creation of the observable instance must be done
 * on the initializing phase". This is a known MST limitation with no
 * workaround when observer components read from the mutated collection.
 *
 * The direct API approach creates the resources server-side, gets back
 * the IDs, and navigates to the project page — which loads its own data
 * fresh. The sidebar project list refreshes on next navigation or refetch.
 */

import { useState, useCallback } from "react"
import { useNavigate } from "react-router-dom"
import { HomePage } from "./dashboard"
import { useWorkspaceData } from "./hooks"
import { useSession } from "@/contexts/SessionProvider"

// ============================================================================
// Direct API helpers (bypass MST to avoid observer race condition)
// ============================================================================

/** Response shape from generated v2 API routes */
interface ApiResponse<T> { ok: boolean; data: T }

async function apiPost<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`API ${url} failed: ${res.status}`)
  const json: ApiResponse<T> = await res.json()
  return json.data
}

function createProjectViaApi(data: {
  name: string
  workspaceId: string
  description?: string
  createdBy: string
}) {
  return apiPost<{ id: string; name: string }>("/api/projects", {
    name: data.name,
    workspaceId: data.workspaceId,
    description: data.description,
    createdBy: data.createdBy,
    tier: "starter",
    status: "draft",
    accessLevel: "anyone",
    schemas: [],
  })
}

function createChatSessionViaApi(data: {
  inferredName: string
  contextType: string
  contextId?: string
}) {
  return apiPost<{ id: string }>("/api/chat-sessions", data)
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a project name from a prompt using simple string extraction.
 */
function generateProjectNameFromPrompt(prompt: string): string {
  const fillerWords = new Set([
    // articles & pronouns
    "a", "an", "the", "to", "for", "with", "that", "this", "is", "are",
    "my", "me", "its", "it", "our", "your", "their",
    // verbs (action words from prompts)
    "create", "build", "make", "design", "develop", "implement", "add", "include",
    "show", "showing", "display", "have", "has", "using", "use",
    // polite / conversational
    "please", "can", "you", "i", "want", "need", "would", "like",
    // generic tech words
    "simple", "basic", "web", "app", "application", "website", "page",
    // conjunctions & prepositions that slip through
    "where", "when", "how", "what", "which", "each", "every", "some",
    "and", "but", "also", "then", "from", "into", "about", "just",
    "nice", "good", "new", "should", "could",
  ])
  const words = prompt.toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter(word => word.length > 2 && !fillerWords.has(word))
  const nameWords = words.slice(0, 3)
  if (nameWords.length === 0) return "New Project"
  return nameWords.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")
}

// ============================================================================
// Component
// ============================================================================

export function WorkspaceLayout() {
  const navigate = useNavigate()
  const { data: session } = useSession()
  const { currentWorkspace } = useWorkspaceData()

  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null)
  const [isCreatingFromPrompt, setIsCreatingFromPrompt] = useState(false)

  /**
   * Handle prompt submission from home page.
   * Creates a project + chat session via API, then navigates with the initial prompt.
   */
  const handlePromptSubmit = useCallback(async (prompt: string, imageData?: string[]) => {
    const userId = session?.user?.id
    const workspaceId = currentWorkspace?.id
    if (!userId || !workspaceId) return

    setIsCreatingFromPrompt(true)
    try {
      const projectName = generateProjectNameFromPrompt(prompt)

      const newProject = await createProjectViaApi({
        name: projectName,
        workspaceId,
        createdBy: userId,
      })

      const chatSession = await createChatSessionViaApi({
        inferredName: `Chat - ${projectName}`,
        contextType: "project",
        contextId: newProject.id,
      })

      navigate(`/projects/${newProject.id}?chatSessionId=${chatSession.id}`, {
        state: {
          project: { id: newProject.id, name: newProject.name },
          chatSessionId: chatSession.id,
          initialMessage: prompt,
          initialImageData: imageData,
        },
      })
    } catch (error) {
      console.error("[WorkspaceLayout] Failed to create from prompt:", error)
    } finally {
      setIsCreatingFromPrompt(false)
    }
  }, [session?.user?.id, currentWorkspace?.id, navigate])

  /**
   * Handle template selection from home page.
   * Creates project + chat session via API, then navigates with an initial
   * message that tells the AI to copy the template files.
   */
  const handleTemplateSelect = useCallback(async (templateName: string, displayName: string) => {
    const userId = session?.user?.id
    const workspaceId = currentWorkspace?.id
    if (!userId || !workspaceId) return

    setLoadingTemplate(templateName)
    try {
      const projectName = `My ${displayName}`

      const newProject = await createProjectViaApi({
        name: projectName,
        workspaceId,
        description: `Created from ${displayName} template`,
        createdBy: userId,
      })

      const chatSession = await createChatSessionViaApi({
        inferredName: `Chat - ${projectName}`,
        contextType: "project",
        contextId: newProject.id,
      })

      const initialMessage = `I want to use the ${templateName} template. Please set up this project by copying the template files, then tell me what I can do next with this ${displayName} app.`

      navigate(`/projects/${newProject.id}?chatSessionId=${chatSession.id}`, {
        state: {
          project: { id: newProject.id, name: newProject.name },
          chatSessionId: chatSession.id,
          initialMessage,
          fromTemplate: templateName,
        },
      })
    } catch (error) {
      console.error("[WorkspaceLayout] Failed to create from template:", error)
    } finally {
      setLoadingTemplate(null)
    }
  }, [session?.user?.id, currentWorkspace?.id, navigate])

  return (
    <div data-testid="workspace-layout" className="h-full">
      <HomePage
        userName={session?.user?.name?.split(" ")[0] || "there"}
        onPromptSubmit={handlePromptSubmit}
        onTemplateSelect={handleTemplateSelect}
        isLoading={isCreatingFromPrompt}
        loadingTemplate={loadingTemplate}
      />
    </div>
  )
}
