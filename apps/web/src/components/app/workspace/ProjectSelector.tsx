/**
 * ProjectSelector Component
 * Task: task-2-2-003
 *
 * Dropdown for project selection using shadcn Select.
 * Displays current project name, lists all organization projects.
 * Includes "Create Project" button at the bottom of the dropdown.
 *
 * Per design decision design-2-2-clean-break:
 * - Fresh component in /components/app/workspace/
 * - Uses shadcn patterns only
 * - Zero imports from /components/Studio/
 *
 * Per ip-2-2-008:
 * - Props: projects, currentProject, onProjectChange, disabled
 * - Shows project name
 * - Disabled when no org selected
 */

import { useState } from "react"
import { Plus } from "lucide-react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { CreateProjectModal } from "./CreateProjectModal"

/**
 * Project entity shape (from studioCore domain)
 */
export interface Project {
  id: string
  name: string
}

/**
 * Props for ProjectSelector component
 */
export interface ProjectSelectorProps {
  /** List of projects in the current organization */
  projects: Project[]
  /** Currently selected project (by ID) */
  currentProject: Project | null
  /** Callback when user selects a different project */
  onProjectChange: (id: string) => void
  /** Disabled state - true when no org selected */
  disabled?: boolean
  /** Loading state - disables selector while data fetches */
  isLoading?: boolean
  /** Current organization ID - required for creating new projects */
  organizationId?: string
}

/**
 * ProjectSelector - Project selection dropdown
 *
 * Uses shadcn Select component for accessible dropdown.
 * Shows current project name as trigger, lists all projects in dropdown.
 * Calls onProjectChange(id) when selection changes.
 * Includes "Create Project" button at the bottom.
 * Disabled when no organization is selected.
 *
 * @example
 * ```tsx
 * <ProjectSelector
 *   projects={[{ id: "1", name: "My Project" }]}
 *   currentProject={{ id: "1", name: "My Project" }}
 *   onProjectChange={(id) => setProjectId(id)}
 *   organizationId="org-123"
 *   disabled={!currentOrg}
 * />
 * ```
 */
export function ProjectSelector({
  projects,
  currentProject,
  onProjectChange,
  disabled = false,
  isLoading = false,
  organizationId,
}: ProjectSelectorProps) {
  // State for Create Project modal
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false)

  // Handle selection change
  const handleValueChange = (value: string) => {
    onProjectChange(value)
  }

  // Handle Create Project button click
  const handleCreateClick = (e: React.MouseEvent) => {
    // Prevent the select from closing/changing
    e.preventDefault()
    e.stopPropagation()
    setShowCreateModal(true)
  }

  // Show skeleton during loading
  if (isLoading) {
    return <Skeleton className="h-9 w-[200px]" />
  }

  return (
    <>
      <Select
        value={currentProject?.id ?? ""}
        onValueChange={handleValueChange}
        disabled={disabled || isLoading}
      >
        <SelectTrigger className="w-[200px]">
          <SelectValue placeholder="Select project" />
        </SelectTrigger>
        <SelectContent>
          {/* Project list */}
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              {project.name}
            </SelectItem>
          ))}

          {/* Visual separator */}
          <SelectSeparator />

          {/* Create Project button */}
          <div className="p-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
              onClick={handleCreateClick}
              disabled={!organizationId}
            >
              <Plus className="h-4 w-4" />
              Create Project
            </Button>
          </div>
        </SelectContent>
      </Select>

      {/* Create Project Modal */}
      {organizationId && (
        <CreateProjectModal
          open={showCreateModal}
          onOpenChange={setShowCreateModal}
          organizationId={organizationId}
        />
      )}
    </>
  )
}
