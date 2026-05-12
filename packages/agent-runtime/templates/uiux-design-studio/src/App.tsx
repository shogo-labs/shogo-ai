import { useState } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ThemeProvider, useTheme } from './components/ThemeProvider'
import DesignSystemView from './components/design/DesignSystemView'
import StyleCard from './components/design/StyleCard'
import type { DesignSystem, UIStyle, DesignProject } from './components/design/types'

const ACTIVE_DESIGN_SYSTEM: DesignSystem | null = null

const STYLES: UIStyle[] = [
  { name: 'Glassmorphism', tier: 1, tierLabel: 'High-Adoption', bestFor: 'Modern SaaS dashboards, fintech apps, and creative portfolios. Frosted-glass surfaces with backdrop blur.', characteristics: ['backdrop-blur', 'transparency', 'layered depth'] },
  { name: 'Neumorphism', tier: 1, tierLabel: 'High-Adoption', bestFor: 'Settings panels, calculator apps, and IoT control interfaces. Soft extruded surfaces.', characteristics: ['soft shadows', 'extruded forms', 'monochrome'] },
  { name: 'Flat Design', tier: 1, tierLabel: 'High-Adoption', bestFor: 'Utility apps, government portals, and accessible interfaces. Zero embellishment.', characteristics: ['no shadows', 'solid colors', 'clean edges'] },
  { name: 'Material Design', tier: 1, tierLabel: 'High-Adoption', bestFor: 'Android apps, enterprise tools, and cross-platform products. Google design language.', characteristics: ['elevation system', 'motion', 'bold color'] },
  { name: 'Minimal / Swiss', tier: 1, tierLabel: 'High-Adoption', bestFor: 'Luxury brands, editorial sites, and typography-focused products. Maximum white space.', characteristics: ['grid system', 'helvetica', 'white space'] },
  { name: 'Dark Mode Premium', tier: 1, tierLabel: 'High-Adoption', bestFor: 'Developer tools, media players, and trading platforms. Dark surfaces with vivid accents.', characteristics: ['dark surfaces', 'vivid accents', 'reduced eye strain'] },
  { name: 'Light & Airy', tier: 1, tierLabel: 'High-Adoption', bestFor: 'Health apps, wedding platforms, and lifestyle products. Soft pastels and generous spacing.', characteristics: ['pastels', 'soft radius', 'breathing room'] },
  { name: 'Brutalism', tier: 1, tierLabel: 'High-Adoption', bestFor: 'Creative agencies, art galleries, and experimental portfolios. Raw, unapologetic layouts.', characteristics: ['bold borders', 'system fonts', 'raw layout'] },
  { name: 'Neo-Brutalism', tier: 1, tierLabel: 'High-Adoption', bestFor: 'Startup landing pages, social apps, and playful SaaS. Brutalism with color and fun.', characteristics: ['thick outlines', 'bright fills', 'shadow offsets'] },
  { name: 'Bento Grid', tier: 1, tierLabel: 'High-Adoption', bestFor: 'Product showcases, portfolio sites, and feature overviews. Apple-inspired grid layouts.', characteristics: ['asymmetric grid', 'large radius', 'featured cells'] },
  { name: 'Dashboard Dense', tier: 2, tierLabel: 'Domain-Specific', bestFor: 'Analytics platforms, admin panels, and monitoring tools. Maximum data density.', characteristics: ['compact spacing', 'data tables', 'metric cards'] },
  { name: 'Data-Heavy Analytical', tier: 2, tierLabel: 'Domain-Specific', bestFor: 'BI tools, scientific dashboards, and financial terminals. Charts and data grids.', characteristics: ['chart-first', 'small text', 'high density'] },
  { name: 'Terminal / CLI', tier: 2, tierLabel: 'Domain-Specific', bestFor: 'Developer tools, hacker interfaces, and system monitoring. Monospace everything.', characteristics: ['monospace', 'green-on-black', 'command prompt'] },
  { name: 'Card-Based', tier: 2, tierLabel: 'Domain-Specific', bestFor: 'Social feeds, news aggregators, and marketplaces. Content in discrete containers.', characteristics: ['contained cards', 'consistent sizing', 'scannable'] },
  { name: 'Magazine Layout', tier: 2, tierLabel: 'Domain-Specific', bestFor: 'News sites, editorial platforms, and long-form content. Multi-column editorial layouts.', characteristics: ['multi-column', 'pull quotes', 'featured images'] },
  { name: 'E-commerce Grid', tier: 2, tierLabel: 'Domain-Specific', bestFor: 'Product catalogs, shopping apps, and comparison sites. Product-card-optimized grids.', characteristics: ['product cards', 'filter sidebar', 'quick view'] },
  { name: 'Chat Interface', tier: 2, tierLabel: 'Domain-Specific', bestFor: 'Messaging apps, support widgets, and AI assistants. Conversation-first layout.', characteristics: ['message bubbles', 'input bar', 'real-time'] },
  { name: 'Retro / Vintage', tier: 3, tierLabel: 'Personality-Driven', bestFor: 'Craft brands, indie games, and nostalgia products. Warm textures and serif fonts.', characteristics: ['serif fonts', 'warm palette', 'texture overlays'] },
  { name: 'Futuristic / Sci-Fi', tier: 3, tierLabel: 'Personality-Driven', bestFor: 'Space tech, gaming, and VR experiences. HUD-style interfaces with glow effects.', characteristics: ['neon glow', 'angular shapes', 'dark base'] },
  { name: 'Organic / Natural', tier: 3, tierLabel: 'Personality-Driven', bestFor: 'Eco brands, wellness apps, and sustainability platforms. Natural shapes and earth tones.', characteristics: ['earth tones', 'organic shapes', 'natural textures'] },
  { name: 'Playful / Illustrated', tier: 3, tierLabel: 'Personality-Driven', bestFor: 'Kids apps, education platforms, and casual games. Hand-drawn elements and bright colors.', characteristics: ['illustrations', 'rounded shapes', 'bright colors'] },
  { name: 'Corporate Professional', tier: 3, tierLabel: 'Personality-Driven', bestFor: 'Enterprise software, consulting firms, and B2B tools. Trust and stability.', characteristics: ['blue palette', 'structured grid', 'formal type'] },
  { name: 'Luxury / Premium', tier: 3, tierLabel: 'Personality-Driven', bestFor: 'High-end retail, exclusive services, and premium subscriptions. Restraint and elegance.', characteristics: ['serif headings', 'muted palette', 'generous space'] },
  { name: 'AI-Native', tier: 4, tierLabel: 'Experimental', bestFor: 'AI products, chatbots, and generative tools. Gradient-rich with conversational layouts.', characteristics: ['gradient mesh', 'streaming text', 'adaptive layout'] },
  { name: 'Spatial / 3D', tier: 4, tierLabel: 'Experimental', bestFor: 'AR/VR dashboards, spatial computing, and immersive experiences. Depth and parallax.', characteristics: ['parallax', 'depth layers', 'perspective'] },
  { name: 'Motion-First', tier: 4, tierLabel: 'Experimental', bestFor: 'Landing pages, brand experiences, and interactive storytelling. Animation drives the narrative.', characteristics: ['scroll animations', 'page transitions', 'micro-interactions'] },
  { name: 'Monochrome', tier: 4, tierLabel: 'Experimental', bestFor: 'Photography portfolios, minimalist brands, and artistic projects. Single hue + neutrals.', characteristics: ['single hue', 'tonal range', 'high contrast'] },
  { name: 'Aurora UI', tier: 6, tierLabel: 'Emerging', bestFor: 'Premium SaaS, creative tools, and next-gen dashboards. Northern lights gradient effects.', characteristics: ['aurora gradients', 'glass layers', 'ambient glow'] },
  { name: 'Claymorphism', tier: 6, tierLabel: 'Emerging', bestFor: 'Friendly SaaS, onboarding flows, and consumer apps. 3D clay-like rendered elements.', characteristics: ['3D rendered', 'soft shadows', 'pastel palette'] },
  { name: 'Skeuomorphism Revival', tier: 6, tierLabel: 'Emerging', bestFor: 'Music apps, note-taking, and tools mimicking physical objects. Real-world material mimicry.', characteristics: ['textures', 'realistic shadows', 'material mimicry'] },
]

const PROJECTS: DesignProject[] = []

function AppContent() {
  const { theme, toggleTheme } = useTheme()
  const [styleFilter, setStyleFilter] = useState('')

  const filteredStyles = STYLES.filter(
    (s) =>
      s.name.toLowerCase().includes(styleFilter.toLowerCase()) ||
      s.bestFor.toLowerCase().includes(styleFilter.toLowerCase()) ||
      s.characteristics.some((c) => c.toLowerCase().includes(styleFilter.toLowerCase()))
  )

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center justify-between max-w-7xl mx-auto">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-blue-500 flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="13.5" cy="6.5" r="2.5" />
                <circle cx="17.5" cy="10.5" r="2.5" />
                <circle cx="8.5" cy="7.5" r="2.5" />
                <circle cx="6.5" cy="12.5" r="2.5" />
                <path d="M12 22C6.5 22 2 17.5 2 12S6.5 2 12 2s10 4.5 10 10-1.5 4-3 4c-1 0-1.5-.5-2-1-.5.5-1 1-2 1s-2.5-1-2.5-3" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold">UI/UX Design Studio</h1>
              <p className="text-xs text-muted-foreground">67 styles &middot; 161 palettes &middot; 57 font pairings</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={toggleTheme} className="cursor-pointer">
            {theme === 'dark' ? 'Light' : 'Dark'}
          </Button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        <Tabs defaultValue="design_system">
          <TabsList>
            <TabsTrigger value="design_system" className="cursor-pointer">Design System</TabsTrigger>
            <TabsTrigger value="style_browser" className="cursor-pointer">Style Browser</TabsTrigger>
            <TabsTrigger value="projects" className="cursor-pointer">Projects</TabsTrigger>
          </TabsList>

          <TabsContent value="design_system" className="mt-6">
            {ACTIVE_DESIGN_SYSTEM ? (
              <DesignSystemView system={ACTIVE_DESIGN_SYSTEM} />
            ) : (
              <EmptyState
                title="No active design system"
                description="Ask the agent to generate a design system for your project. It will analyze your industry, recommend a style, select colors and typography, and produce a complete system."
                action='Try: "Generate a design system for a fintech dashboard"'
              />
            )}
          </TabsContent>

          <TabsContent value="style_browser" className="mt-6 space-y-4">
            <div className="flex items-center gap-3">
              <Input
                placeholder="Filter styles by name, use case, or characteristic..."
                value={styleFilter}
                onChange={(e) => setStyleFilter(e.target.value)}
                className="max-w-md"
              />
              <Badge variant="secondary">{filteredStyles.length} styles</Badge>
            </div>
            {filteredStyles.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filteredStyles.map((style) => (
                  <StyleCard key={style.name} style={style} />
                ))}
              </div>
            ) : (
              <EmptyState
                title="No matching styles"
                description="Try a different search term or clear the filter."
              />
            )}
          </TabsContent>

          <TabsContent value="projects" className="mt-6">
            {PROJECTS.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {PROJECTS.map((project) => (
                  <Card key={project.id} className="cursor-pointer hover:border-primary/50 transition-colors">
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between">
                        <CardTitle className="text-base">{project.name}</CardTitle>
                        <Badge variant={project.status === 'active' ? 'default' : 'secondary'}>
                          {project.status}
                        </Badge>
                      </div>
                      <CardDescription>{project.industry}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>Style: {project.style}</span>
                        <span>{project.lastUpdated}</span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No design projects yet"
                description="Start a conversation with the agent to create your first design project. Each project tracks its design system, critiques, and iterations."
                action='Try: "Start a new design project for an e-commerce app"'
              />
            )}
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}

function EmptyState({ title, description, action }: { title: string; description: string; action?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center mb-4">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
          <circle cx="13.5" cy="6.5" r="2.5" />
          <circle cx="17.5" cy="10.5" r="2.5" />
          <circle cx="8.5" cy="7.5" r="2.5" />
          <circle cx="6.5" cy="12.5" r="2.5" />
          <path d="M12 22C6.5 22 2 17.5 2 12S6.5 2 12 2s10 4.5 10 10-1.5 4-3 4c-1 0-1.5-.5-2-1-.5.5-1 1-2 1s-2.5-1-2.5-3" />
        </svg>
      </div>
      <h3 className="text-lg font-semibold mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground max-w-md">{description}</p>
      {action && (
        <p className="text-xs font-mono text-muted-foreground mt-4 px-3 py-1.5 rounded-md bg-muted">
          {action}
        </p>
      )}
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  )
}
