/**
 * CanvasThemePicker
 *
 * Compact toolbar controls for canvas theming:
 * - Dark/light/system toggle
 * - Color theme preset picker (swatch grid)
 *
 * The palette dropdown renders via a DOM portal so it escapes
 * React Native Web's default overflow:hidden on parent Views.
 */

import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { View, Pressable, Platform } from 'react-native'
import { createPortal } from 'react-dom'
import { Text } from '@/components/ui/text'
import { Sun, Moon, Monitor, Palette, Check } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useCanvasTheme } from './CanvasThemeContext'
import { CANVAS_THEMES, type CanvasColorScheme } from './canvas-themes'

const SCHEME_OPTIONS: { id: CanvasColorScheme; icon: typeof Sun; label: string }[] = [
  { id: 'light', icon: Sun, label: 'Light' },
  { id: 'dark', icon: Moon, label: 'Dark' },
  { id: 'system', icon: Monitor, label: 'System' },
]

/**
 * Renders children into a portal at the document body,
 * escaping all parent overflow clipping.
 */
function DropdownPortal({ children }: { children: ReactNode }) {
  if (Platform.OS !== 'web') return null
  return createPortal(children, document.body)
}

export function CanvasThemePicker() {
  if (Platform.OS !== 'web') return null

  const { colorScheme, setColorScheme, themeId, setThemeId } = useCanvasTheme()
  const [showPalette, setShowPalette] = useState(false)
  const triggerRef = useRef<View>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [anchorRect, setAnchorRect] = useState<{ top: number; right: number } | null>(null)

  const openPalette = useCallback(() => {
    const el = triggerRef.current as unknown as HTMLElement | null
    if (el) {
      const rect = el.getBoundingClientRect()
      setAnchorRect({ top: rect.bottom + 6, right: window.innerWidth - rect.right })
    }
    setShowPalette(true)
  }, [])

  useEffect(() => {
    if (!showPalette) return
    const handler = (e: MouseEvent) => {
      const trigger = triggerRef.current as unknown as HTMLElement | null
      const panel = panelRef.current
      if (trigger?.contains(e.target as Node)) return
      if (panel?.contains(e.target as Node)) return
      setShowPalette(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showPalette])

  const activeTheme = CANVAS_THEMES.find((t) => t.id === themeId)

  return (
    <View className="flex-row items-center gap-1.5">
      {/* Color scheme toggle (segmented control) */}
      <View className="flex-row items-center bg-muted rounded-lg p-0.5">
        {SCHEME_OPTIONS.map(({ id, icon: Icon, label }) => (
          <Pressable
            key={id}
            onPress={() => setColorScheme(id)}
            className={cn(
              'px-2 py-1 rounded-md flex-row items-center gap-1',
              colorScheme === id && 'bg-background shadow-sm',
            )}
          >
            <Icon
              size={13}
              className={cn(
                colorScheme === id ? 'text-foreground' : 'text-muted-foreground',
              )}
            />
            <Text
              className={cn(
                'text-[11px] font-medium',
                colorScheme === id ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Color theme picker trigger */}
      <View ref={triggerRef}>
        <Pressable
          onPress={() => (showPalette ? setShowPalette(false) : openPalette())}
          className={cn(
            'flex-row items-center gap-1.5 px-2 py-1 rounded-md',
            showPalette ? 'bg-accent' : 'hover:bg-muted',
          )}
        >
          <View
            className="w-4 h-4 rounded-full border border-border"
            style={{ backgroundColor: activeTheme?.swatch ?? '#2563eb' }}
          />
          <Palette size={13} className="text-muted-foreground" />
        </Pressable>
      </View>

      {showPalette && anchorRect && (
        <DropdownPortal>
          <div
            ref={panelRef}
            style={{
              position: 'fixed',
              top: anchorRect.top,
              right: anchorRect.right,
              zIndex: 9999,
              width: 240,
              background: 'var(--color-popover, #fff)',
              border: '1px solid var(--color-border, #e4e4e7)',
              borderRadius: 12,
              padding: 12,
              boxShadow: '0 8px 30px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)',
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-muted-foreground, #71717a)', marginBottom: 8 }}>
              Color Theme
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {CANVAS_THEMES.map((theme) => (
                <button
                  key={theme.id}
                  onClick={() => {
                    setThemeId(theme.id)
                    setShowPalette(false)
                  }}
                  style={{
                    width: 52,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 4,
                    padding: 6,
                    borderRadius: 8,
                    border: 'none',
                    cursor: 'pointer',
                    background: themeId === theme.id ? 'var(--color-accent, #f4f4f5)' : 'transparent',
                  }}
                >
                  <div style={{ position: 'relative', width: 28, height: 28 }}>
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: '50%',
                        backgroundColor: theme.swatch,
                        border: themeId === theme.id ? `2px solid ${theme.swatch}` : '2px solid transparent',
                      }}
                    />
                    {themeId === theme.id && (
                      <div style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <span style={{
                    fontSize: 10,
                    color: themeId === theme.id ? 'var(--color-foreground, #0a0a0a)' : 'var(--color-muted-foreground, #71717a)',
                    fontWeight: themeId === theme.id ? 500 : 400,
                    whiteSpace: 'nowrap',
                  }}>
                    {theme.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </DropdownPortal>
      )}
    </View>
  )
}
