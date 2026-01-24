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
import { useDomains } from "@/contexts/DomainProvider"
import { useWorkspaceData } from "@/components/app/workspace/hooks"
import { useTemplates, type TemplateMetadata } from "@/hooks/useTemplates"

export const TemplatesPage = observer(function TemplatesPage() {
  const navigate = useNavigate()
  const { studioCore } = useDomains()
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
    if (!studioCore || !currentWorkspace?.id) {
      console.error("[TemplatesPage] No studioCore or workspace")
      return
    }

    setLoadingTemplate(template.name)
    
    try {
      // Create project with template name
      const displayName = formatTemplateName(template.name)
      const project = await studioCore.createProject(displayName, currentWorkspace.id)
      
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
        <h1 className="text-2xl font-semibold">Templates</h1>
        <p className="text-muted-foreground mt-1">
          Start from a template to build your next project
        </p>
      </div>

      {/* Templates grid */}
      <div className="flex-1 overflow-auto px-6 pb-6">
        {isLoadingTemplates ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : templates.length === 0 ? (
          <div className="text-center py-20 text-muted-foreground">
            No templates available
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
