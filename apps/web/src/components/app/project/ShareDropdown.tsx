/**
 * ShareDropdown - Lovable.dev-style share panel
 *
 * Exact styling matches:
 * - Avatar with coral background + "Share" text (no icon)
 * - "Add people" full-width button
 * - Clean project access list
 * - Invite link toggle with "Create invite link" button
 * - Share preview and Publish project buttons
 */

import { useState } from "react"
import {
  Users,
  Link2,
  Share2,
  Globe,
  ChevronDown,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

interface Collaborator {
  id: string
  name: string
  initial: string
  role: "owner" | "editor" | "viewer"
}

export interface ShareDropdownProps {
  projectId: string
  collaborators?: Collaborator[]
  currentUserName?: string
  userInitial?: string
  workspaceName?: string
  inviteLinkEnabled?: boolean
  onAddPeople?: () => void
  onChangeRole?: (userId: string, role: string) => void
  onToggleInviteLink?: (enabled: boolean) => void
  onCreateInviteLink?: () => void
  onSharePreview?: () => void
  onPublish?: () => void
}

export function ShareDropdown({
  projectId,
  collaborators = [],
  currentUserName = "You",
  userInitial = "Y",
  workspaceName = "My Workspace",
  inviteLinkEnabled = false,
  onAddPeople,
  onChangeRole,
  onToggleInviteLink,
  onCreateInviteLink,
  onSharePreview,
  onPublish,
}: ShareDropdownProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2 hover:bg-accent/50"
        >
          {/* Coral avatar */}
          <div className="h-5 w-5 rounded-full bg-orange-500 flex items-center justify-center">
            <span className="text-[10px] font-medium text-white">{userInitial}</span>
          </div>
          <span className="text-sm">Share</span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="p-4 space-y-4">
          {/* Header */}
          <h2 className="font-semibold text-sm">Share project</h2>

          {/* Add People Button */}
          <Button
            variant="secondary"
            className="w-full justify-start h-9 text-sm bg-muted/50 hover:bg-muted"
            onClick={onAddPeople}
          >
            Add people
          </Button>

          {/* Project Access Section */}
          <div className="space-y-3">
            <h3 className="text-xs font-medium text-muted-foreground">
              Project access
            </h3>

            {/* People you invited */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">People you invited</span>
              </div>
              <div className="flex items-center">
                {collaborators.length > 0 ? (
                  <div className="flex -space-x-1">
                    {collaborators.slice(0, 3).map((c) => (
                      <div
                        key={c.id}
                        className="h-5 w-5 rounded-full bg-orange-500 flex items-center justify-center border-2 border-background"
                      >
                        <span className="text-[10px] font-medium text-white">
                          {c.initial}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="h-5 w-5 rounded-full bg-orange-500 flex items-center justify-center">
                    <span className="text-[10px] font-medium text-white">{userInitial}</span>
                  </div>
                )}
                <ChevronDown className="h-3 w-3 ml-1 text-muted-foreground" />
              </div>
            </div>

            {/* Workspace */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-5 w-5 rounded bg-orange-500/20 flex items-center justify-center">
                  <span className="text-[10px] font-medium text-orange-500">
                    {workspaceName.charAt(0)}
                  </span>
                </div>
                <span className="text-sm">{workspaceName}</span>
              </div>
              <Button variant="ghost" size="sm" className="h-6 text-xs gap-1 px-2">
                Can edit
                <ChevronDown className="h-3 w-3" />
              </Button>
            </div>

            {/* Current User (Owner) */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-5 w-5 rounded-full bg-orange-500 flex items-center justify-center">
                  <span className="text-[10px] font-medium text-white">{userInitial}</span>
                </div>
                <span className="text-sm">{currentUserName} (you)</span>
              </div>
              <span className="text-xs text-muted-foreground">Owner</span>
            </div>

            {/* Invite Link */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Link2 className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">Invite link</span>
                </div>
                <Button variant="ghost" size="sm" className="h-6 text-xs gap-1 px-2">
                  {inviteLinkEnabled ? "Enabled" : "Disabled"}
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </div>

              {/* Create invite link button */}
              <Button
                variant="outline"
                className="w-full h-8 text-sm"
                onClick={onCreateInviteLink}
              >
                Create invite link
              </Button>
            </div>
          </div>
        </div>

        <DropdownMenuSeparator className="my-0" />

        {/* Bottom Actions */}
        <div className="p-3 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 h-8 gap-1.5 text-xs"
            onClick={onSharePreview}
          >
            <Share2 className="h-3.5 w-3.5" />
            Share preview
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1 h-8 gap-1.5 text-xs"
            onClick={onPublish}
          >
            <Globe className="h-3.5 w-3.5" />
            Publish project
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
