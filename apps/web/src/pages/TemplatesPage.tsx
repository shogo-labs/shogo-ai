/**
 * TemplatesPage - Full canvas templates gallery
 * 
 * Displays all canvas dev examples as agent templates.
 * Clicking a template creates a new project with the example prompt.
 */

import { useState } from "react"
import { observer } from "mobx-react-lite"
import { useNavigate } from "react-router-dom"
import { TemplateCard, formatTemplateName, type CanvasTemplate } from "@/components/app/workspace/dashboard/TemplateCard"
import { useDomainActions } from "@/generated/domain-actions"
import { useSession } from "@/contexts/SessionProvider"
import { useWorkspaceData } from "@/components/app/workspace/hooks"
import { useTemplates } from "@/hooks/useTemplates"

export const TemplatesPage = observer(function TemplatesPage() {
  const navigate = useNavigate()
  const actions = useDomainActions()
  const { data: session } = useSession()
  const { currentWorkspace, refetchProjects } = useWorkspaceData()

  const { templates } = useTemplates()
  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null)

  const handleTemplateClick = async (template: CanvasTemplate) => {
    const userId = session?.user?.id
    if (!userId || !currentWorkspace?.id) {
      console.error("[TemplatesPage] No user session or workspace")
      return
    }

    setLoadingTemplate(template.id)
    
    try {
      const displayName = formatTemplateName(template.id)
      const project = await actions.createProject(displayName, currentWorkspace.id, undefined, userId, "AGENT")
      
      if (project?.id) {
        refetchProjects()
        navigate(`/projects/${project.id}`, {
          state: {
            initialMessage: template.user_request,
          },
        })
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
        <h1 className="text-2xl font-semibold">Canvas Templates</h1>
        <p className="text-muted-foreground mt-1">
          Start from a template — click to create a project with this prompt
        </p>
      </div>

      {/* Templates grid */}
      <div className="flex-1 overflow-auto px-6 pb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              isLoading={loadingTemplate === template.id}
              onClick={() => handleTemplateClick(template)}
            />
          ))}
        </div>
      </div>
    </div>
  )
})
