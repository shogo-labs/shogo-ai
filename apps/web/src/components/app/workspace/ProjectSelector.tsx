/**
 * ProjectSelector Component
 * Task: task-2-2-003
 *
 * Dropdown for project selection using shadcn Select.
 * Displays current project name, lists all organization projects.
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

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"

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
}

/**
 * ProjectSelector - Project selection dropdown
 *
 * Uses shadcn Select component for accessible dropdown.
 * Shows current project name as trigger, lists all projects in dropdown.
 * Calls onProjectChange(id) when selection changes.
 * Disabled when no organization is selected.
 *
 * @example
 * ```tsx
 * <ProjectSelector
 *   projects={[{ id: "1", name: "My Project" }]}
 *   currentProject={{ id: "1", name: "My Project" }}
 *   onProjectChange={(id) => setProjectId(id)}
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
}: ProjectSelectorProps) {
  // Handle selection change
  const handleValueChange = (value: string) => {
    onProjectChange(value)
  }

  // Show skeleton during loading
  if (isLoading) {
    return <Skeleton className="h-9 w-[200px]" />
  }

  return (
    <Select
      value={currentProject?.id ?? ""}
      onValueChange={handleValueChange}
      disabled={disabled || isLoading}
    >
      <SelectTrigger className="w-[200px]">
        <SelectValue placeholder="Select project" />
      </SelectTrigger>
      <SelectContent>
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
