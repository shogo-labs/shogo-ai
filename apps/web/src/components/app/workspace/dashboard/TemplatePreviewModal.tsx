/**
 * TemplatePreviewModal - Canvas template preview dialog
 *
 * Shows what the agent will build when the template is used:
 * - Template name and the prompt that will be sent
 * - Component types the canvas will include
 * - Whether it uses a CRUD API
 * - "Use template" action button
 */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Loader2, Sparkles, Database, LayoutDashboard } from "lucide-react"
import { type CanvasTemplate, formatTemplateName } from "./TemplateCard"

interface TemplatePreviewModalProps {
  template: CanvasTemplate | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onUseTemplate: (template: CanvasTemplate) => void
  isLoading?: boolean
}

const COMPONENT_LABELS: Record<string, { label: string; color: string }> = {
  Chart: { label: "Charts", color: "bg-violet-500/10 text-violet-400 border-violet-500/20" },
  Table: { label: "Tables", color: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
  Metric: { label: "Metrics", color: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  Card: { label: "Cards", color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  Tabs: { label: "Tabs", color: "bg-pink-500/10 text-pink-400 border-pink-500/20" },
  DataList: { label: "Data List", color: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20" },
  Accordion: { label: "Accordion", color: "bg-orange-500/10 text-orange-400 border-orange-500/20" },
  Button: { label: "Buttons", color: "bg-rose-500/10 text-rose-400 border-rose-500/20" },
  TextField: { label: "Text Fields", color: "bg-sky-500/10 text-sky-400 border-sky-500/20" },
  Select: { label: "Selects", color: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20" },
  Checkbox: { label: "Checkboxes", color: "bg-lime-500/10 text-lime-400 border-lime-500/20" },
  Badge: { label: "Badges", color: "bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/20" },
  Progress: { label: "Progress", color: "bg-teal-500/10 text-teal-400 border-teal-500/20" },
  Alert: { label: "Alerts", color: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20" },
  Image: { label: "Images", color: "bg-purple-500/10 text-purple-400 border-purple-500/20" },
  ChoicePicker: { label: "Choice Picker", color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
}

const LAYOUT_TYPES = new Set(["Column", "Row", "Grid", "ScrollArea"])

export function TemplatePreviewModal({
  template,
  open,
  onOpenChange,
  onUseTemplate,
  isLoading = false,
}: TemplatePreviewModalProps) {
  if (!template) return null

  const displayComponents = template.component_types.filter(
    (c) => !LAYOUT_TYPES.has(c) && c !== "Text" && c !== "Separator" && c !== "AccordionItem" && c !== "TabPanel"
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border space-y-0 shrink-0">
          <DialogTitle className="text-xl font-semibold">
            {formatTemplateName(template.id)}
          </DialogTitle>
        </DialogHeader>

        <div className="px-6 py-5 flex flex-col gap-5">
          {/* Prompt preview */}
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Prompt
            </p>
            <p className="text-sm text-foreground leading-relaxed bg-muted/50 rounded-lg px-4 py-3 border border-border/50">
              "{template.user_request}"
            </p>
          </div>

          {/* Type badge */}
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Type
            </p>
            <div className="flex items-center gap-2">
              {template.needs_api_schema ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                  <Database className="h-3.5 w-3.5" />
                  CRUD App — includes a managed API with create, read, update, delete
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  <LayoutDashboard className="h-3.5 w-3.5" />
                  Display — data-populated canvas with no backend
                </span>
              )}
            </div>
          </div>

          {/* Components */}
          {displayComponents.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Components ({template.component_count} total)
              </p>
              <div className="flex flex-wrap gap-1.5">
                {displayComponents.map((comp) => {
                  const info = COMPONENT_LABELS[comp]
                  return (
                    <span
                      key={comp}
                      className={`inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full border ${
                        info?.color ?? "bg-muted text-muted-foreground border-border"
                      }`}
                    >
                      {info?.label ?? comp}
                    </span>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer with action */}
        <div className="px-6 py-4 border-t border-border flex justify-end">
          <Button
            onClick={() => onUseTemplate(template)}
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Creating...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4 mr-2" />
                Use template
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
