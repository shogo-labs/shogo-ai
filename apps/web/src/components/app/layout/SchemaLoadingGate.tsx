/**
 * SchemaLoadingGate - Blocks rendering until domain schemas are loaded
 *
 * Prevents race conditions where components try to query collections
 * before schemas are loaded from MCP. Shows a loading indicator during
 * the async schema loading phase.
 *
 * This gate should be placed inside DomainProvider but outside components
 * that access domain stores (like AuthGate, AppShell, etc.).
 *
 * @example
 * ```tsx
 * <DomainProvider domains={domains}>
 *   <SchemaLoadingGate>
 *     <AuthGate>
 *       <AppShell />
 *     </AuthGate>
 *   </SchemaLoadingGate>
 * </DomainProvider>
 * ```
 */

import { Loader2 } from "lucide-react"
import { useSchemaLoadingState } from "@shogo/app-core"

export interface SchemaLoadingGateProps {
  children: React.ReactNode
}

/**
 * SchemaLoadingGate component
 *
 * Renders a loading indicator while schemas are being loaded,
 * then renders children once schemas are ready.
 */
export function SchemaLoadingGate({ children }: SchemaLoadingGateProps) {
  const { schemasLoaded, schemasLoading } = useSchemaLoadingState()

  // Show loading indicator while schemas are being loaded
  if (!schemasLoaded || schemasLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          {/* App branding */}
          <h1 className="text-2xl font-semibold text-foreground">Shogo Studio</h1>

          {/* Loading spinner */}
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />

          {/* Loading text */}
          <p className="text-sm text-muted-foreground">Loading workspace...</p>
        </div>
      </div>
    )
  }

  // Schemas loaded - render children
  return <>{children}</>
}
