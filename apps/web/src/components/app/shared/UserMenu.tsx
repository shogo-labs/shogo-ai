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

import { useState, useCallback } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import { clearUserLocalStorage } from "@/lib/clear-user-storage"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { LogOut, User, Sun, Moon, Monitor } from "lucide-react"
import { Link } from "react-router-dom"

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

// Theme state helpers
function getTheme(): "light" | "dark" | "system" {
  if (typeof window === "undefined") return "system"
  const stored = localStorage.getItem("theme")
  if (stored === "dark" || stored === "light") return stored
  return "system"
}

function setTheme(theme: "light" | "dark" | "system") {
  if (theme === "system") {
    localStorage.removeItem("theme")
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
    document.documentElement.classList.toggle("dark", prefersDark)
  } else {
    localStorage.setItem("theme", theme)
    document.documentElement.classList.toggle("dark", theme === "dark")
  }
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

  // Theme state
  const [currentTheme, setCurrentTheme] = useState<"light" | "dark" | "system">(getTheme)

  // Get current theme icon
  const ThemeIcon = currentTheme === "dark" ? Moon : currentTheme === "light" ? Sun : Monitor

  const handleThemeChange = useCallback((value: string) => {
    const theme = value as "light" | "dark" | "system"
    setTheme(theme)
    setCurrentTheme(theme)
  }, [])

  const handleSignOut = async () => {
    try { sessionStorage.setItem('shogo:just-signed-out', '1') } catch {}
    try {
      await auth.signOut()
    } catch (error) {
      console.error("Sign out failed:", error)
    } finally {
      clearUserLocalStorage()
      window.location.reload()
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

        <DropdownMenuItem asChild className="cursor-pointer">
          <Link to="/profile">
            <User className="mr-2 h-4 w-4" />
            <span>Profile</span>
          </Link>
        </DropdownMenuItem>

        {/* Appearance submenu */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ThemeIcon className="mr-2 h-4 w-4" />
            <span>Appearance</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={currentTheme} onValueChange={handleThemeChange}>
              <DropdownMenuRadioItem value="light" className="gap-2">
                <Sun className="h-4 w-4" />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark" className="gap-2">
                <Moon className="h-4 w-4" />
                Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system" className="gap-2">
                <Monitor className="h-4 w-4" />
                System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuItem onClick={handleSignOut} className="cursor-pointer">
          <LogOut className="mr-2 h-4 w-4" />
          <span>Sign Out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})
