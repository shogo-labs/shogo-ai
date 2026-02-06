/**
 * App Components Barrel Export
 * Tasks: task-2-1-013, task-2-2-008
 * Integration Points: ip-2-1-component-index, ip-2-2-018
 *
 * Main barrel file for all Studio App components.
 * Provides clean imports for App.tsx route configuration.
 *
 * Per design-2-2-clean-break:
 * - Only exports from /components/app/ subdirectories
 * - Zero re-exports from /components/Studio/
 *
 * Usage:
 *   import { AuthGate, AppShell, LoginPage } from "@/components/app"
 *   import { WorkspaceSwitcher, WorkspaceLayout } from "@/components/app"
 */

// Layout components
export { AuthGate, AppShell, AppHeader, SchemaLoadingGate } from "./layout"

// Auth components
export { LoginPage, SignInForm, SignUpForm, GoogleOAuthButton } from "./auth"

// Shared components
export { UserMenu, ThemeToggle, SplashScreen } from "./shared"

// Workspace components (Session 2.2)
export * from "./workspace"
