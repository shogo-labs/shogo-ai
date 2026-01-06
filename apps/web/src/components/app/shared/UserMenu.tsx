/**
 * UserMenu - User dropdown menu component
 * Task: task-2-1-009
 *
 * Displays a dropdown menu with:
 * - Avatar trigger showing user initials or image
 * - User name and email in dropdown header
 * - Separator between user info and actions
 * - Sign Out action that calls auth.signOut()
 *
 * Uses shadcn DropdownMenu and Avatar components.
 * Integrates with betterAuthDomain via useDomains().auth.
 */

import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { LogOut } from "lucide-react"

/**
 * Get user initials from name
 * @param name - Full name string
 * @returns Up to 2 uppercase initials
 */
function getInitials(name: string | null | undefined): string {
  if (!name) return "?"
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)
}

/**
 * UserMenu component
 *
 * Renders a dropdown menu triggered by the user's avatar.
 * Shows user info and sign out action.
 */
export const UserMenu = observer(function UserMenu() {
  const { auth } = useDomains()

  const currentUser = auth.currentUser
  const userName = currentUser?.name || currentUser?.email || "User"
  const userEmail = currentUser?.email || ""
  const userImage = currentUser?.image

  const handleSignOut = async () => {
    try {
      await auth.signOut()
    } catch (error) {
      console.error("Sign out failed:", error)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex items-center justify-center rounded-full focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          aria-label="User menu"
        >
          <Avatar>
            {userImage && <AvatarImage src={userImage} alt={userName} />}
            <AvatarFallback>{getInitials(currentUser?.name)}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">{userName}</p>
            <p className="text-xs leading-none text-muted-foreground">
              {userEmail}
            </p>
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={handleSignOut} className="cursor-pointer">
          <LogOut className="mr-2 h-4 w-4" />
          <span>Sign Out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})
