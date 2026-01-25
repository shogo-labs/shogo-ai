/**
 * ThemeSelector - Theme selection dropdown
 * 
 * Dropdown component for selecting project themes.
 * Shows preset themes with color swatches and a "Create new" button.
 * Inspired by Lovable.dev's theme selector UI.
 */

import { useState, useCallback } from "react"
import { Palette, Check, Plus, Settings2, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ThemeSwatch } from "./ThemeSwatch"
import { THEME_PRESETS, type ThemePreset } from "@/lib/themes"

interface ThemeSelectorProps {
  /** Currently selected theme ID */
  selectedThemeId: string
  /** Callback when theme is selected */
  onSelectTheme: (themeId: string) => void
  /** Callback when "Create new" is clicked */
  onCreateNew?: () => void
  /** Callback when settings/customize is clicked */
  onCustomize?: () => void
  /** Whether the selector is disabled */
  disabled?: boolean
  /** Display variant */
  variant?: "button" | "compact"
  /** Additional class names */
  className?: string
}

/**
 * ThemeSelector component
 * 
 * Renders a dropdown button that shows available themes with color previews.
 */
export function ThemeSelector({
  selectedThemeId,
  onSelectTheme,
  onCreateNew,
  onCustomize,
  disabled = false,
  variant = "button",
  className,
}: ThemeSelectorProps) {
  const [open, setOpen] = useState(false)

  // Find currently selected theme
  const selectedTheme = THEME_PRESETS.find(t => t.id === selectedThemeId)

  const handleSelectTheme = useCallback((themeId: string) => {
    onSelectTheme(themeId)
    setOpen(false)
  }, [onSelectTheme])

  const handleCreateNew = useCallback(() => {
    onCreateNew?.()
    setOpen(false)
  }, [onCreateNew])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {variant === "compact" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              "h-8 gap-1.5 text-muted-foreground hover:text-foreground",
              className
            )}
            disabled={disabled}
          >
            <Palette className="h-4 w-4" />
            <span className="hidden sm:inline text-xs">Theme</span>
            <ChevronDown className="h-3 w-3 opacity-50" />
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn("h-9 gap-2", className)}
            disabled={disabled}
          >
            <Palette className="h-4 w-4" />
            <span className="text-sm">
              {selectedTheme?.name || "Select Theme"}
            </span>
            {selectedTheme && (
              <ThemeSwatch
                primary={selectedTheme.preview.primary}
                secondary={selectedTheme.preview.secondary}
                accent={selectedTheme.preview.accent}
                background={selectedTheme.preview.background}
                size="sm"
              />
            )}
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent 
        className="w-64 p-0" 
        align="start"
        sideOffset={8}
      >
        <div className="p-2 border-b border-border">
          <p className="text-xs font-medium text-muted-foreground px-2">
            Select theme
          </p>
        </div>
        
        <ScrollArea className="h-[280px]">
          <div className="p-2">
            {/* Default themes section */}
            <div className="mb-2">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-2 mb-1">
                Default themes
              </p>
              <div className="space-y-0.5">
                {THEME_PRESETS.map((theme) => (
                  <ThemePresetItem
                    key={theme.id}
                    theme={theme}
                    isSelected={theme.id === selectedThemeId}
                    onSelect={() => handleSelectTheme(theme.id)}
                  />
                ))}
              </div>
            </div>
          </div>
        </ScrollArea>

        {/* Footer actions */}
        <div className="p-2 border-t border-border flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 flex-1 justify-start gap-2 text-xs"
            onClick={handleCreateNew}
          >
            <Plus className="h-3.5 w-3.5" />
            Create new
          </Button>
          {onCustomize && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => {
                onCustomize()
                setOpen(false)
              }}
            >
              <Settings2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Individual theme preset item in the dropdown
 */
interface ThemePresetItemProps {
  theme: ThemePreset
  isSelected: boolean
  onSelect: () => void
}

function ThemePresetItem({ theme, isSelected, onSelect }: ThemePresetItemProps) {
  return (
    <button
      type="button"
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        isSelected && "bg-accent text-accent-foreground"
      )}
      onClick={onSelect}
    >
      {isSelected ? (
        <Check className="h-4 w-4 text-primary shrink-0" />
      ) : (
        <div className="h-4 w-4 shrink-0" />
      )}
      <span className="flex-1 text-left truncate">{theme.name}</span>
      <ThemeSwatch
        primary={theme.preview.primary}
        secondary={theme.preview.secondary}
        accent={theme.preview.accent}
        background={theme.preview.background}
        size="sm"
      />
    </button>
  )
}

export default ThemeSelector
