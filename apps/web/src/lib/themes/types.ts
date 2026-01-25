/**
 * Theme Types
 * 
 * TypeScript interfaces for the theme configuration system.
 * Follows the shadcn/Tailwind CSS variable pattern used by Lovable.dev.
 * 
 * All colors are stored as HSL values without the hsl() wrapper,
 * e.g., "222.2 47.4% 11.2%" for direct use in CSS custom properties.
 */

/**
 * HSL color value as a string (without hsl() wrapper)
 * Format: "hue saturation% lightness%"
 * Example: "222.2 47.4% 11.2%"
 */
export type HSLColor = string

/**
 * Color pair for semantic colors (base + foreground text)
 */
export interface ColorPair {
  /** Base color */
  DEFAULT: HSLColor
  /** Foreground/text color for contrast */
  foreground: HSLColor
}

/**
 * Full color configuration for a theme
 * Maps to CSS custom properties in index.css
 */
export interface ThemeColors {
  /** Page/app background */
  background: HSLColor
  /** Default text color */
  foreground: HSLColor
  
  /** Card backgrounds and their text */
  card: ColorPair
  
  /** Popover/dropdown backgrounds and their text */
  popover: ColorPair
  
  /** Primary brand color (buttons, links, etc.) */
  primary: ColorPair
  
  /** Secondary/subtle elements */
  secondary: ColorPair
  
  /** Muted/disabled states */
  muted: ColorPair
  
  /** Accent highlights */
  accent: ColorPair
  
  /** Destructive/error states (red) */
  destructive: ColorPair
  
  /** Border color */
  border: HSLColor
  
  /** Input border color */
  input: HSLColor
  
  /** Focus ring color */
  ring: HSLColor
  
  /** Chart colors (optional, for data visualization) */
  chart?: {
    1: HSLColor
    2: HSLColor
    3: HSLColor
    4: HSLColor
    5: HSLColor
  }
  
  /** Sidebar-specific colors (optional) */
  sidebar?: {
    background: HSLColor
    foreground: HSLColor
    primary: HSLColor
    primaryForeground: HSLColor
    accent: HSLColor
    accentForeground: HSLColor
    border: HSLColor
    ring: HSLColor
  }
}

/**
 * Typography configuration
 */
export interface ThemeTypography {
  /** Sans-serif font family */
  fontSans?: string
  /** Serif font family */
  fontSerif?: string
  /** Monospace font family */
  fontMono?: string
}

/**
 * Visual effects configuration
 */
export interface ThemeEffects {
  /** Border radius (in rem, e.g., "0.5") */
  radius: string
  
  /** Shadow configuration */
  shadow?: {
    /** Shadow color (HSL) */
    color: HSLColor
    /** Shadow opacity (0-1) */
    opacity: number
    /** Blur radius in pixels */
    blur: number
    /** Spread radius in pixels */
    spread: number
    /** X offset in pixels */
    offsetX: number
    /** Y offset in pixels */
    offsetY: number
  }
}

/**
 * Complete theme configuration
 */
export interface ThemeConfig {
  /** Unique identifier for the theme */
  id: string
  
  /** Display name */
  name: string
  
  /** Optional description */
  description?: string
  
  /** Light mode colors */
  light: ThemeColors
  
  /** Dark mode colors */
  dark: ThemeColors
  
  /** Typography settings (optional) */
  typography?: ThemeTypography
  
  /** Visual effects (optional) */
  effects?: ThemeEffects
}

/**
 * Theme preset metadata (for display in selector)
 */
export interface ThemePreset {
  /** Unique identifier */
  id: string
  
  /** Display name */
  name: string
  
  /** Preview colors for the selector (4 swatches) */
  preview: {
    /** Primary color for swatch */
    primary: HSLColor
    /** Secondary color for swatch */
    secondary: HSLColor
    /** Accent color for swatch */
    accent: HSLColor
    /** Background color for swatch */
    background: HSLColor
  }
  
  /** Full theme configuration */
  config: ThemeConfig
}

/**
 * Theme state for a project
 */
export interface ProjectThemeState {
  /** Currently selected theme ID */
  themeId: string
  
  /** Custom overrides (if user modified a preset) */
  customizations?: Partial<ThemeConfig>
  
  /** Whether using a custom theme (not a preset) */
  isCustom: boolean
}

/**
 * Storage format for persisting theme selection
 */
export interface StoredThemeSelection {
  /** Theme ID or 'custom' */
  themeId: string
  
  /** Custom theme config (if isCustom) */
  customConfig?: ThemeConfig
  
  /** Timestamp of last update */
  updatedAt: string
}
