/**
 * TemplatesPage - Full templates gallery page matching Lovable's design
 * 
 * Displays all available SDK templates in a 3-column grid with:
 * - Page title and description
 * - Template cards with screenshots
 * - Click to open preview modal
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { Loader2 } from "lucide-react"
import { TemplateCard, formatTemplateName } from "@/components/app/workspace/dashboard/TemplateCard"
import { TemplatePreviewModal } from "@/components/app/workspace/dashboard/TemplatePreviewModal"
import { useNavigate } from "react-router-dom"
import { useDomainActions } from "@/generated/domain-actions"
import { useSession } from "@/contexts/SessionProvider"
import { useWorkspaceData } from "@/components/app/workspace/hooks"
import { useTemplates, type TemplateMetadata } from "@/hooks/useTemplates"

export const TemplatesPage = observer(function TemplatesPage() {
  const navigate = useNavigate()
  const actions = useDomainActions()
  const { data: session } = useSession()
  const { currentWorkspace, refetchProjects } = useWorkspaceData()

  // Templates state - use shared hook with deduplication
  const { templates, isLoading: isLoadingTemplates } = useTemplates()
  
  // Modal state
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateMetadata | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null)

  const handleTemplateClick = (template: TemplateMetadata) => {
    setSelectedTemplate(template)
    setIsModalOpen(true)
  }

  const handleUseTemplate = async (template: TemplateMetadata) => {
    const userId = session?.user?.id
    if (!userId || !currentWorkspace?.id) {
      console.error("[TemplatesPage] No user session or workspace")
      return
    }

    setLoadingTemplate(template.name)
    
    try {
      // Create project with template name
      const displayName = formatTemplateName(template.name)
      const project = await actions.createProject(displayName, currentWorkspace.id, undefined, userId, "AGENT")
      
      if (project?.id) {
        refetchProjects()
        setIsModalOpen(false)
        // Navigate to the new project - the WorkspaceLayout will handle template copying
        navigate(`/projects/${project.id}?template=${template.name}`)
      }
    } catch (error) {
      console.error("[TemplatesPage] Failed to create project:", error)
    } finally {
      setLoadingTemplate(null)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <h1 className="text-2xl font-semibold">Agent Templates</h1>
        <p className="text-muted-foreground mt-1">
          Start from a template to build your next agent
        </p>
      </div>

      {/* Templates grid */}
      <div className="flex-1 overflow-auto px-6 pb-6">
        {isLoadingTemplates ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : templates.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <p className="text-muted-foreground">
              No templates available yet
            </p>
            <p className="text-sm text-muted-foreground max-w-md">
              Templates will appear here as they become available. In the meantime, start a new project and describe what you want to build.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-6">
            {templates.map((template) => (
              <TemplateCard
                key={template.name}
                template={template}
                isLoading={loadingTemplate === template.name}
                onClick={() => handleTemplateClick(template)}
              />
            ))}
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
    </div>
  )
})
