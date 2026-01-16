/**
 * ProjectTopBar - Minimal top navigation bar for project view
 *
 * Similar to Lovable.dev's project header with:
 * - Back button to return to dashboard
 * - Project name
 * - Share/Settings buttons
 */

import { ArrowLeft, Share2, Settings, MoreHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useNavigate } from "react-router-dom"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export interface ProjectTopBarProps {
  projectName: string
  projectId: string
  onShare?: () => void
  onSettings?: () => void
}

export function ProjectTopBar({
  projectName,
  projectId,
  onShare,
  onSettings,
}: ProjectTopBarProps) {
  const navigate = useNavigate()

  const handleBack = () => {
    // Navigate back to projects list
    navigate("/projects")
  }

  return (
    <header className="h-14 border-b bg-background flex items-center justify-between px-4">
      {/* Left: Back button and project name */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleBack}
          className="h-8 w-8"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="flex items-center gap-2">
          <span className="font-medium">{projectName}</span>
        </div>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onShare}
          className="gap-2"
        >
          <Share2 className="h-4 w-4" />
          Share
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onSettings}>
              <Settings className="h-4 w-4 mr-2" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive">
              Delete Project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
