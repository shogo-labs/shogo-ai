/**
 * TemplatePreviewModal - Clean template preview dialog matching Lovable's design
 *
 * Features:
 * - Simple header with template name
 * - "Use template" action button
 * - Full-height screenshot preview (no fake browser chrome)
 */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Loader2, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { type TemplateMetadata, formatTemplateName } from "./TemplateCard"

interface TemplatePreviewModalProps {
  /** The template to preview */
  template: TemplateMetadata | null
  /** Whether the modal is open */
  open: boolean
  /** Callback when modal should close */
  onOpenChange: (open: boolean) => void
  /** Callback when user clicks "Use template" */
  onUseTemplate: (template: TemplateMetadata) => void
  /** Whether template is being created */
  isLoading?: boolean
}

export function TemplatePreviewModal({
  template,
  open,
  onOpenChange,
  onUseTemplate,
  isLoading = false,
}: TemplatePreviewModalProps) {
  if (!template) return null

  const screenshotUrl = `/templates/${template.name}.png`

  const handleUseTemplate = () => {
    onUseTemplate(template)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl w-[95vw] h-[90vh] p-0 gap-0 overflow-hidden flex flex-col" hideCloseButton>
        {/* Header - matching Lovable's simple style */}
        <DialogHeader className="px-6 py-4 border-b border-border flex-row items-center justify-between space-y-0 shrink-0">
          <div className="flex-1 min-w-0">
            <DialogTitle className="text-lg font-semibold truncate">
              {formatTemplateName(template.name)}
            </DialogTitle>
            <p className="text-sm text-muted-foreground mt-0.5 truncate">
              {template.description.split(".")[0]}
            </p>
          </div>
          <Button
            onClick={handleUseTemplate}
            disabled={isLoading}
            className="ml-4 shrink-0"
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
        </DialogHeader>

        {/* Preview area - clean screenshot display */}
        <div className="flex-1 overflow-auto bg-muted/30">
          <img
            src={screenshotUrl}
            alt={`${formatTemplateName(template.name)} preview`}
            className={cn(
              "w-full h-auto min-h-full object-contain",
              "bg-background"
            )}
            onError={(e) => {
              // On error, show placeholder
              const target = e.currentTarget
              target.style.display = 'none'
              const parent = target.parentElement
              if (parent) {
                const placeholder = document.createElement('div')
                placeholder.className = 'flex-1 flex flex-col items-center justify-center p-8 text-muted-foreground'
                placeholder.innerHTML = `
                  <div class="text-6xl mb-4 opacity-40">📄</div>
                  <p class="text-lg font-medium">${formatTemplateName(template.name)}</p>
                  <p class="text-sm opacity-60 mt-1">Preview unavailable</p>
                `
                parent.appendChild(placeholder)
              }
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
