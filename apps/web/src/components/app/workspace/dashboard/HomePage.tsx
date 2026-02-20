/**
 * HomePage - Main dashboard/home page component
 *
 * Displays when no project is selected. Features:
 * - Personalized greeting with user's name
 * - Beautiful gradient mesh background
 * - AI prompt input via ChatPanel in compact mode
 * - SDK example templates that can be selected to create new projects
 *
 * Template flow (inspired by Lovable.dev):
 * 1. User clicks a template card
 * 2. Project is created with template name
 * 3. Template files are copied via template.copy MCP
 * 4. User is navigated to the new project with a welcome message
 */

import { useState, useRef, type RefObject } from "react"
import { observer } from "mobx-react-lite"
import { useNavigate } from "react-router-dom"
import { Sparkles, ChevronRight, Loader2 } from "lucide-react"
import type { ProjectType } from "@/components/app/chat/CompactChatInput"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ChatPanel } from "@/components/app/chat/ChatPanel"
import { TemplateCard, formatTemplateName, type TemplateMetadata } from "./TemplateCard"
import { TemplatePreviewModal } from "./TemplatePreviewModal"
import { useTemplates } from "@/hooks/useTemplates"
import { useProjectTheme } from "@/hooks/useProjectTheme"
import { ThemeEditorDialog } from "@/components/app/shared/ThemeEditorDialog"

/** Transition phases for HomePage to Workspace animation */
export type TransitionPhase = 'idle' | 'commit' | 'dissolve' | 'transform' | 'emerge' | 'settle' | 'complete'

interface HomePageProps {
  /** User's display name for personalized greeting */
  userName?: string
  /** Callback when a new prompt is submitted (includes selected themeId and project type) */
  onPromptSubmit?: (prompt: string, imageData?: string[], themeId?: string, projectType?: ProjectType) => void
  /** Callback when a template is selected - receives template name, display name, and themeId */
  onTemplateSelect?: (templateName: string, displayName: string, themeId?: string) => void
  /** Loading state - true when creating project/feature from prompt */
  isLoading?: boolean
  /** Template currently being loaded (template name) */
  loadingTemplate?: string | null
  /** Current transition phase for animation (default: 'idle') */
  transitionPhase?: TransitionPhase
  /** Ref for the input card element (used for FLIP animation position capture) */
  inputRef?: RefObject<HTMLDivElement>
  /** FLIP animation styles (position:fixed + CSS vars) - applied during transition */
  flipStyle?: React.CSSProperties | null
}

/**
 * HomePage component
 * 
 * Main landing page for the app dashboard when no project is selected.
 * Features a personalized greeting and AI-powered prompt interface.
 */
export const HomePage = observer(function HomePage({
  userName = "there",
  onPromptSubmit,
  onTemplateSelect,
  isLoading = false,
  loadingTemplate = null,
  transitionPhase = 'idle',
  inputRef,
  flipStyle,
}: HomePageProps) {
  const navigate = useNavigate()
  // Prompt state managed here so suggestions can pre-fill
  const [prompt, setPrompt] = useState("")
  // Project type toggle: App or Agent
  const [projectType, setProjectType] = useState<ProjectType>("APP")
  // Internal ref for ChatPanel if external ref not provided
  const internalInputRef = useRef<HTMLDivElement>(null)
  const chatPanelRef = inputRef ?? internalInputRef

  // Templates state - use shared hook with deduplication
  const { templates, isLoading: isLoadingTemplates } = useTemplates()
  
  // Theme selection state
  const { 
    currentThemeId, 
    selectTheme, 
  } = useProjectTheme()
  
  // Theme editor dialog state (for "Create new" button)
  const [isThemeEditorOpen, setIsThemeEditorOpen] = useState(false)
  
  // Template preview modal state
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateMetadata | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)

  // Get first name only for greeting
  const firstName = userName.split(" ")[0] || "there"

  // Handle template card click - opens preview modal
  const handleTemplateClick = (template: TemplateMetadata) => {
    setSelectedTemplate(template)
    setIsModalOpen(true)
  }

  // Handle "Use template" from modal
  const handleUseTemplate = (template: TemplateMetadata) => {
    if (onTemplateSelect && !loadingTemplate) {
      onTemplateSelect(template.name, formatTemplateName(template.name), currentThemeId !== 'default' ? currentThemeId : undefined)
      setIsModalOpen(false)
    }
  }

  return (
    <div
      className="relative h-full flex flex-col overflow-y-auto"
      data-home-element="root"
      data-transition-phase={transitionPhase}
    >
      {/* Animated gradient mesh background - inspired by Lovable.dev */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {/* Primary gradient orb - large, blue to pink */}
        <div
          className="home-gradient-orb absolute w-[800px] h-[800px] rounded-full blur-[120px] animate-gradient-shift"
          data-home-element="orb-primary"
          style={{
            background: "radial-gradient(circle, rgba(59, 130, 246, 0.6) 0%, rgba(139, 92, 246, 0.5) 40%, rgba(236, 72, 153, 0.4) 100%)",
            top: "10%",
            left: "20%",
            animation: "gradient-float 15s ease-in-out infinite",
          }}
        />

        {/* Secondary gradient orb - orange to pink */}
        <div
          className="home-gradient-orb absolute w-[600px] h-[600px] rounded-full blur-[100px]"
          data-home-element="orb-secondary"
          style={{
            background: "radial-gradient(circle, rgba(249, 115, 22, 0.5) 0%, rgba(236, 72, 153, 0.5) 50%, rgba(139, 92, 246, 0.3) 100%)",
            bottom: "5%",
            right: "10%",
            animation: "gradient-float-reverse 18s ease-in-out infinite",
          }}
        />

        {/* Tertiary gradient orb - cyan accent */}
        <div
          className="home-gradient-orb absolute w-[500px] h-[500px] rounded-full blur-[100px]"
          data-home-element="orb-tertiary"
          style={{
            background: "radial-gradient(circle, rgba(34, 211, 238, 0.3) 0%, rgba(59, 130, 246, 0.3) 100%)",
            top: "50%",
            right: "30%",
            animation: "gradient-pulse 12s ease-in-out infinite",
          }}
        />

        {/* Hot pink accent orb */}
        <div
          className="home-gradient-orb absolute w-[400px] h-[400px] rounded-full blur-[80px]"
          data-home-element="orb-pink"
          style={{
            background: "radial-gradient(circle, rgba(236, 72, 153, 0.5) 0%, rgba(168, 85, 247, 0.3) 100%)",
            top: "30%",
            left: "50%",
            transform: "translateX(-50%)",
            animation: "gradient-float 20s ease-in-out infinite reverse",
          }}
        />
      </div>
      
      {/* CSS Keyframe animations */}
      <style>{`
        @keyframes gradient-float {
          0%, 100% {
            transform: translate(0, 0) scale(1);
          }
          33% {
            transform: translate(30px, -30px) scale(1.05);
          }
          66% {
            transform: translate(-20px, 20px) scale(0.95);
          }
        }
        
        @keyframes gradient-float-reverse {
          0%, 100% {
            transform: translate(0, 0) scale(1);
          }
          33% {
            transform: translate(-25px, 25px) scale(1.03);
          }
          66% {
            transform: translate(15px, -15px) scale(0.97);
          }
        }
        
        @keyframes gradient-pulse {
          0%, 100% {
            opacity: 0.3;
            transform: scale(1);
          }
          50% {
            opacity: 0.5;
            transform: scale(1.1);
          }
        }
      `}</style>

      {/* Main content */}
      <div className="relative flex flex-col items-center justify-center p-8 min-h-[60vh]">
        {/* Greeting */}
        <h1
          className="home-greeting text-3xl sm:text-4xl md:text-5xl font-bold text-center mb-8 bg-clip-text text-transparent bg-gradient-to-r from-foreground via-foreground to-foreground/80"
          data-home-element="greeting"
        >
          What's on your mind, {firstName}?
        </h1>

        {/* AI Prompt Input Card - ChatPanel in compact mode */}
        <div
          ref={chatPanelRef}
          className="home-input-card w-full max-w-2xl"
          data-home-element="input-card"
          data-flip-animating={flipStyle ? '' : undefined}
          style={flipStyle ?? undefined}
        >
          <ChatPanel
            mode="compact"
            featureId={null}
            phase={null}
            onCompactSubmit={(p) => onPromptSubmit?.(p, [], currentThemeId !== 'default' ? currentThemeId : undefined, projectType)}
            compactValue={prompt}
            onCompactValueChange={setPrompt}
            selectedThemeId={currentThemeId}
            onSelectTheme={selectTheme}
            onCreateTheme={() => setIsThemeEditorOpen(true)}
            projectType={projectType}
            onProjectTypeChange={setProjectType}
          />
        </div>

        {/* Quick suggestions */}
        <div
          className="home-suggestions mt-6 flex flex-wrap justify-center gap-2"
          data-home-element="suggestions"
        >
          {[
            "Build a landing page",
            "Create a dashboard",
            "Design a form",
            "Make an API integration",
          ].map((suggestion) => (
            <Button
              key={suggestion}
              variant="outline"
              size="sm"
              className="h-8 text-xs bg-card/50 backdrop-blur-sm hover:bg-card"
              onClick={() => setPrompt(suggestion)}
            >
              <Sparkles className="h-3 w-3 mr-1.5 text-purple-400" />
              {suggestion}
            </Button>
          ))}
        </div>
      </div>

      {/* Templates section */}
      <div
        className="home-templates relative bg-card/30 backdrop-blur-sm border-t border-border py-6"
        data-home-element="templates"
      >
        <div className="flex items-center justify-between mb-4 px-6">
          <h2 className="text-sm font-medium">Templates</h2>
          <Button
            variant="ghost"
            size="sm"
            className="text-sm text-muted-foreground hover:text-foreground gap-1"
            onClick={() => navigate("/templates")}
          >
            Browse all
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        
        {/* Template cards - 3-column grid */}
        {isLoadingTemplates ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : templates.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            No templates available
          </div>
        ) : (
          <div className="px-6 pb-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-5xl mx-auto">
              {templates.map((template) => (
                <TemplateCard
                  key={template.name}
                  template={template}
                  isLoading={loadingTemplate === template.name}
                  onClick={() => handleTemplateClick(template)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Template Preview Modal */}
      <TemplatePreviewModal
        template={selectedTemplate}
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
        onUseTemplate={handleUseTemplate}
        isLoading={loadingTemplate !== null}
      />
      
      {/* Theme Editor Dialog */}
      <ThemeEditorDialog
        open={isThemeEditorOpen}
        onOpenChange={setIsThemeEditorOpen}
        selectedThemeId={currentThemeId}
        onSaveTheme={(themeId) => {
          selectTheme(themeId)
          setIsThemeEditorOpen(false)
        }}
      />
    </div>
  )
})
