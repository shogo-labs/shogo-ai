/**
 * Clear all user-specific localStorage data.
 * 
 * Call this on sign-out, sign-in, AND sign-up to prevent stale data
 * from a previous user session causing race conditions (e.g., loading
 * a workspace that doesn't belong to the new user → 400 errors).
 *
 * Keys preserved: theme, chat-panel-collapsed, chat-panel-width,
 * app-sidebar-collapsed (UI preferences, not user-specific).
 */
export function clearUserLocalStorage() {
  try {
    const keysToRemove: string[] = []

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key) {
        // Current workspace selection (critical - causes 400 errors if stale)
        if (key === "shogo-current-workspace") {
          keysToRemove.push(key)
        }
        // Chat session history for all projects
        if (key.startsWith("shogo:lastChatSession:")) {
          keysToRemove.push(key)
        }
        // Advanced chat preference
        if (key === "advanced-chat-preferred") {
          keysToRemove.push(key)
        }
        // Workspace-related cached data (both : and - prefixes)
        if (key.startsWith("shogo:workspace:") || key.startsWith("shogo-workspace")) {
          keysToRemove.push(key)
        }
      }
    }

    keysToRemove.forEach(key => {
      localStorage.removeItem(key)
    })

    if (keysToRemove.length > 0) {
      console.log("[auth] Cleared", keysToRemove.length, "user-specific localStorage items")
    }
  } catch (error) {
    // Ignore localStorage errors (e.g., in incognito mode)
    console.warn("[auth] Could not clear localStorage:", error)
  }
}
