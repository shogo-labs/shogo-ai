export interface ColorToken {
  name: string
  light: string
  dark: string
}

export interface ColorPalette {
  name: string
  tokens: ColorToken[]
}

export interface FontSpec {
  family: string
  googleFontsUrl: string
  fallback: string
}

export interface TypographyPairing {
  heading: FontSpec
  body: FontSpec
  mono: FontSpec
  scale: Record<string, string>
}

export interface DesignSystem {
  projectName: string
  category: string
  domain: string
  audience: string
  pattern: { name: string; rationale: string }
  style: { name: string; tier: number; characteristics: string[] }
  colors: ColorPalette
  typography: TypographyPairing
  effects: { shadows: string; borderRadius: string; transitions: string; extras: string[] }
  antiPatterns: { critical: string[]; major: string[]; minor: string[] }
  checklist: { label: string; done: boolean }[]
}

export interface UIStyle {
  name: string
  tier: number
  tierLabel: string
  bestFor: string
  characteristics: string[]
}

export interface DesignProject {
  id: string
  name: string
  industry: string
  status: 'active' | 'completed' | 'archived'
  style: string
  lastUpdated: string
}

export interface CritiqueReviewer {
  name: string
  role: string
  score: number
  summary: string
}

export interface CritiqueFinding {
  severity: 'critical' | 'major' | 'minor' | 'nit'
  status: 'FAIL' | 'WARN' | 'PASS'
  reviewer: string
  description: string
  location: string
  fix: string
}

export interface CritiqueResult {
  target: string
  reviewers: CritiqueReviewer[]
  compositeScore: number
  findings: CritiqueFinding[]
  verdict: 'SHIP' | 'REVISE' | 'REDESIGN'
  summary: string
}
