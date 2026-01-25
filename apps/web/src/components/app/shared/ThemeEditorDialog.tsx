/**
 * ThemeEditorDialog - Full theme customization dialog
 * 
 * Dialog for creating and editing custom themes.
 * Provides tabs for Colors, Typography, and Effects configuration
 * with a live preview panel.
 * 
 * Inspired by Lovable.dev's theme editor.
 */

import { useState, useCallback, useMemo } from "react"
import { X, Check, RotateCcw, Palette, Type, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ThemeSwatch } from "./ThemeSwatch"
import { 
  type ThemeConfig, 
  type ThemePreset,
  THEME_PRESETS,
  getThemeById,
  getDefaultTheme,
  hslToHex,
} from "@/lib/themes"

interface ThemeEditorDialogProps {
  /** Whether the dialog is open */
  open: boolean
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void
  /** Currently selected theme ID */
  selectedThemeId: string
  /** Callback when a theme is saved/selected */
  onSaveTheme: (themeId: string, config?: ThemeConfig) => void
  /** Optional callback when theme is changed (for live preview) */
  onPreviewTheme?: (config: ThemeConfig) => void
}

/**
 * ThemeEditorDialog component
 * 
 * Full-featured theme editor with tabs for colors, typography, and effects.
 */
export function ThemeEditorDialog({
  open,
  onOpenChange,
  selectedThemeId,
  onSaveTheme,
  onPreviewTheme,
}: ThemeEditorDialogProps) {
  // Get the base theme to edit
  const baseTheme = getThemeById(selectedThemeId) ?? getDefaultTheme()
  
  // Local state for edited theme
  const [editedTheme, setEditedTheme] = useState<ThemeConfig>(baseTheme)
  const [hasChanges, setHasChanges] = useState(false)
  const [activeTab, setActiveTab] = useState<"colors" | "typography" | "effects">("colors")
  
  // Reset to selected theme
  const handleReset = useCallback(() => {
    setEditedTheme(baseTheme)
    setHasChanges(false)
  }, [baseTheme])
  
  // Save theme - use editedTheme.id since user may have selected a different preset
  const handleSave = useCallback(() => {
    onSaveTheme(editedTheme.id, hasChanges ? editedTheme : undefined)
    onOpenChange(false)
  }, [editedTheme, hasChanges, onSaveTheme, onOpenChange])
  
  // Select a preset theme
  const handleSelectPreset = useCallback((preset: ThemePreset) => {
    setEditedTheme(preset.config)
    setHasChanges(true)
    onPreviewTheme?.(preset.config)
  }, [onPreviewTheme])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[80vh] flex flex-col p-0 gap-0">
        {/* Header */}
        <DialogHeader className="px-6 py-4 border-b">
          <DialogTitle className="flex items-center gap-2">
            <Palette className="h-5 w-5" />
            Manage themes
          </DialogTitle>
          <DialogDescription>
            Customize the look and feel of your app
          </DialogDescription>
        </DialogHeader>
        
        {/* Content */}
        <div className="flex-1 flex min-h-0">
          {/* Left panel - Editor */}
          <div className="w-80 border-r flex flex-col">
            {/* Theme selector */}
            <div className="p-4 border-b">
              <p className="text-xs font-medium text-muted-foreground mb-2">
                Base theme
              </p>
              <ScrollArea className="h-32">
                <div className="space-y-1 pr-4">
                  {THEME_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
                        "hover:bg-accent hover:text-accent-foreground",
                        editedTheme.id === preset.id && "bg-accent text-accent-foreground"
                      )}
                      onClick={() => handleSelectPreset(preset)}
                    >
                      {editedTheme.id === preset.id ? (
                        <Check className="h-4 w-4 text-primary shrink-0" />
                      ) : (
                        <div className="h-4 w-4 shrink-0" />
                      )}
                      <span className="flex-1 text-left truncate">{preset.name}</span>
                      <ThemeSwatch
                        primary={preset.preview.primary}
                        secondary={preset.preview.secondary}
                        accent={preset.preview.accent}
                        background={preset.preview.background}
                        size="sm"
                      />
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </div>
            
            {/* Editor tabs */}
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)} className="flex-1 flex flex-col">
              <TabsList className="mx-4 mt-4 grid w-auto grid-cols-3">
                <TabsTrigger value="colors" className="text-xs">
                  <Palette className="h-3 w-3 mr-1" />
                  Colors
                </TabsTrigger>
                <TabsTrigger value="typography" className="text-xs">
                  <Type className="h-3 w-3 mr-1" />
                  Typography
                </TabsTrigger>
                <TabsTrigger value="effects" className="text-xs">
                  <Sparkles className="h-3 w-3 mr-1" />
                  Effects
                </TabsTrigger>
              </TabsList>
              
              <ScrollArea className="flex-1">
                <TabsContent value="colors" className="p-4 m-0">
                  <ColorEditor 
                    theme={editedTheme} 
                    onChange={(theme) => {
                      setEditedTheme(theme)
                      setHasChanges(true)
                      onPreviewTheme?.(theme)
                    }} 
                  />
                </TabsContent>
                
                <TabsContent value="typography" className="p-4 m-0">
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    Typography customization coming soon
                  </div>
                </TabsContent>
                
                <TabsContent value="effects" className="p-4 m-0">
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    Effects customization coming soon
                  </div>
                </TabsContent>
              </ScrollArea>
            </Tabs>
          </div>
          
          {/* Right panel - Preview */}
          <div className="flex-1 flex flex-col bg-muted/30">
            <div className="p-4 border-b flex items-center justify-between">
              <span className="text-sm font-medium">Preview</span>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleReset}
                  disabled={!hasChanges}
                >
                  <RotateCcw className="h-4 w-4 mr-1" />
                  Reset
                </Button>
              </div>
            </div>
            <div className="flex-1 p-4">
              <ThemePreview theme={editedTheme} />
            </div>
          </div>
        </div>
        
        {/* Footer */}
        <div className="px-6 py-4 border-t flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>
            {hasChanges ? "Save changes" : "Done"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Color editor section
 */
interface ColorEditorProps {
  theme: ThemeConfig
  onChange: (theme: ThemeConfig) => void
}

function ColorEditor({ theme, onChange }: ColorEditorProps) {
  const colorGroups = [
    {
      title: "Primary",
      colors: [
        { key: "primary.DEFAULT", label: "Primary", value: theme.light.primary.DEFAULT },
        { key: "primary.foreground", label: "Primary Text", value: theme.light.primary.foreground },
      ],
    },
    {
      title: "Secondary", 
      colors: [
        { key: "secondary.DEFAULT", label: "Secondary", value: theme.light.secondary.DEFAULT },
        { key: "secondary.foreground", label: "Secondary Text", value: theme.light.secondary.foreground },
      ],
    },
    {
      title: "Accent",
      colors: [
        { key: "accent.DEFAULT", label: "Accent", value: theme.light.accent.DEFAULT },
        { key: "accent.foreground", label: "Accent Text", value: theme.light.accent.foreground },
      ],
    },
    {
      title: "Base",
      colors: [
        { key: "background", label: "Background", value: theme.light.background },
        { key: "foreground", label: "Foreground", value: theme.light.foreground },
      ],
    },
  ]

  return (
    <div className="space-y-4">
      {colorGroups.map((group) => (
        <div key={group.title}>
          <p className="text-xs font-medium text-muted-foreground mb-2">
            {group.title}
          </p>
          <div className="space-y-2">
            {group.colors.map((color) => (
              <div 
                key={color.key}
                className="flex items-center gap-2 p-2 rounded-md bg-card border"
              >
                <div 
                  className="w-8 h-8 rounded border border-border"
                  style={{ backgroundColor: `hsl(${color.value})` }}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{color.label}</p>
                  <p className="text-xs text-muted-foreground font-mono">
                    {hslToHex(color.value)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="text-xs text-muted-foreground text-center pt-4">
        Full color picker coming soon. For now, select a preset theme above.
      </p>
    </div>
  )
}

/**
 * Theme preview panel
 */
interface ThemePreviewProps {
  theme: ThemeConfig
}

function ThemePreview({ theme }: ThemePreviewProps) {
  // Generate inline styles from theme for preview
  const previewStyles = useMemo(() => {
    const { light } = theme
    return {
      '--preview-background': `hsl(${light.background})`,
      '--preview-foreground': `hsl(${light.foreground})`,
      '--preview-primary': `hsl(${light.primary.DEFAULT})`,
      '--preview-primary-foreground': `hsl(${light.primary.foreground})`,
      '--preview-secondary': `hsl(${light.secondary.DEFAULT})`,
      '--preview-muted': `hsl(${light.muted.DEFAULT})`,
      '--preview-muted-foreground': `hsl(${light.muted.foreground})`,
      '--preview-border': `hsl(${light.border})`,
      '--preview-card': `hsl(${light.card.DEFAULT})`,
      '--preview-card-foreground': `hsl(${light.card.foreground})`,
    } as React.CSSProperties
  }, [theme])

  return (
    <div 
      className="h-full rounded-lg border overflow-hidden"
      style={{
        ...previewStyles,
        backgroundColor: 'var(--preview-background)',
        color: 'var(--preview-foreground)',
      }}
    >
      <div className="p-4 space-y-4">
        {/* Sample card */}
        <div 
          className="p-4 rounded-lg border"
          style={{
            backgroundColor: 'var(--preview-card)',
            color: 'var(--preview-card-foreground)',
            borderColor: 'var(--preview-border)',
          }}
        >
          <h3 className="font-semibold mb-2">Sample Card</h3>
          <p 
            className="text-sm mb-3"
            style={{ color: 'var(--preview-muted-foreground)' }}
          >
            This is how your content will look with this theme.
          </p>
          <div className="flex gap-2">
            <button
              className="px-3 py-1.5 rounded-md text-sm font-medium"
              style={{
                backgroundColor: 'var(--preview-primary)',
                color: 'var(--preview-primary-foreground)',
              }}
            >
              Primary
            </button>
            <button
              className="px-3 py-1.5 rounded-md text-sm font-medium border"
              style={{
                backgroundColor: 'var(--preview-secondary)',
                color: 'var(--preview-foreground)',
                borderColor: 'var(--preview-border)',
              }}
            >
              Secondary
            </button>
          </div>
        </div>
        
        {/* Sample form */}
        <div 
          className="p-4 rounded-lg border"
          style={{
            backgroundColor: 'var(--preview-card)',
            borderColor: 'var(--preview-border)',
          }}
        >
          <label className="block text-sm font-medium mb-1">
            Email
          </label>
          <input
            type="text"
            placeholder="you@example.com"
            className="w-full px-3 py-2 rounded-md border text-sm"
            style={{
              backgroundColor: 'var(--preview-background)',
              borderColor: 'var(--preview-border)',
              color: 'var(--preview-foreground)',
            }}
            readOnly
          />
        </div>
      </div>
    </div>
  )
}

export default ThemeEditorDialog
