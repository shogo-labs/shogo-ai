/**
 * SectionBrowserSection Component
 * Task: view-builder-implementation
 *
 * Standalone section that displays ComponentDefinition details for a given section name.
 * This is extracted from AppShellSection's internal SectionBrowserView to be reusable
 * as a standalone section in compositions.
 *
 * Config options:
 * - sectionName: string - Explicit section name to display (takes precedence)
 * - useActiveItem: boolean - If true, reads activeItem from AppShellContext (default: false)
 * - exampleConfig: object - Optional config passed to live preview
 *
 * When useActiveItem=true, this section reads the active item from AppShellContext,
 * enabling dynamic content updates when navigating in an AppShell sidebar.
 */

import { observer } from "mobx-react-lite"
import { Code, Layout, Tag, FileText, Sparkles } from "lucide-react"
import type { SectionRendererProps } from "../types"
import { DynamicSectionRenderer } from "../sectionImplementations"
import { useDomains } from "@/contexts/DomainProvider"
import { useAppShell } from "../contexts/AppShellContext"

// ============================================================================
// Types
// ============================================================================

interface SectionBrowserConfig {
  /** Explicit section name to display (takes precedence over activeItem) */
  sectionName?: string
  /** If true, reads activeItem from AppShellContext */
  useActiveItem?: boolean
  /** Example configuration for live preview */
  exampleConfig?: Record<string, unknown>
  /** Map of section names to example configs (for dynamic activeItem mode) */
  exampleConfigs?: Record<string, Record<string, unknown>>
}

// ============================================================================
// Main Component
// ============================================================================

export const SectionBrowserSection = observer(function SectionBrowserSection({
  feature,
  config,
}: SectionRendererProps) {
  const browserConfig = config as SectionBrowserConfig | undefined
  const appShell = useAppShell()
  const domains = useDomains()
  const componentBuilder = domains?.componentBuilder

  // Determine which section to display
  // Priority: explicit sectionName > activeItem from context
  let sectionName: string | null = browserConfig?.sectionName ?? null

  if (!sectionName && browserConfig?.useActiveItem && appShell) {
    sectionName = appShell.activeItem
  }

  // Determine example config
  // Priority: explicit exampleConfig > lookup in exampleConfigs map
  let exampleConfig = browserConfig?.exampleConfig
  if (!exampleConfig && sectionName && browserConfig?.exampleConfigs) {
    exampleConfig = browserConfig.exampleConfigs[sectionName]
  }

  // No section selected
  if (!sectionName) {
    return (
      <div className="flex items-center justify-center p-8 min-h-[300px]">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Layout className="w-8 h-8 text-primary" />
          </div>
          <h3 className="text-lg font-semibold mb-2">Select a Section</h3>
          <p className="text-muted-foreground text-sm">
            {browserConfig?.useActiveItem
              ? "Click an item in the sidebar to view its details."
              : "Provide a sectionName in the config to display section details."}
          </p>
        </div>
      </div>
    )
  }

  // Try to find the ComponentDefinition by name
  const componentDef = componentBuilder?.componentDefinitionCollection?.findByName?.(sectionName)

  if (!componentDef) {
    return (
      <div className="flex items-center justify-center p-8 min-h-[300px]">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
            <FileText className="w-8 h-8 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-2">Section Not Found</h3>
          <p className="text-muted-foreground text-sm">
            No ComponentDefinition found for "{sectionName}".
            This section may not be registered in the component-builder schema.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Layout className="w-6 h-6 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-foreground">{componentDef.name}</h1>
            <p className="text-muted-foreground mt-1">{componentDef.description || 'No description available'}</p>
          </div>
        </div>

        {/* Metadata badges */}
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
            <Tag className="w-3 h-3" />
            {componentDef.category}
          </span>
          {componentDef.tags?.map((tag: string) => (
            <span
              key={tag}
              className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-muted text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>

        {/* Implementation Reference */}
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 mb-2">
            <Code className="w-4 h-4 text-muted-foreground" />
            <h3 className="font-medium text-sm">Implementation Reference</h3>
          </div>
          <code className="text-sm bg-muted px-2 py-1 rounded font-mono">
            {componentDef.implementationRef}
          </code>
        </div>

        {/* Supported Config */}
        {componentDef.supportedConfig && componentDef.supportedConfig.length > 0 && (
          <div className="rounded-lg border bg-card p-4">
            <h3 className="font-medium text-sm mb-3">Supported Config Options</h3>
            <div className="flex flex-wrap gap-2">
              {componentDef.supportedConfig.map((configKey: string) => (
                <code
                  key={configKey}
                  className="text-xs bg-muted px-2 py-1 rounded font-mono"
                >
                  {configKey}
                </code>
              ))}
            </div>
          </div>
        )}

        {/* AI Guidance */}
        {componentDef.aiGuidance && (
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-4 h-4 text-primary" />
              <h3 className="font-medium text-sm">AI Configuration Guide</h3>
            </div>
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <pre className="text-xs bg-muted/50 p-4 rounded-lg overflow-auto whitespace-pre-wrap">
                {componentDef.aiGuidance}
              </pre>
            </div>
          </div>
        )}

        {/* Live Preview */}
        {exampleConfig !== undefined && (
          <div className="rounded-lg border bg-card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/30">
              <Layout className="w-4 h-4 text-primary" />
              <h3 className="font-medium text-sm">Live Preview</h3>
              <span className="text-xs text-muted-foreground ml-auto">
                with example config
              </span>
            </div>
            <div className="min-h-[200px] max-h-[500px] overflow-auto bg-background">
              <DynamicSectionRenderer
                sectionName={sectionName}
                feature={feature}
                config={exampleConfig}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
})
