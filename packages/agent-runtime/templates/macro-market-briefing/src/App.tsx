import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import MacroDashboard from './surfaces/MacroDashboard'
import SectorRotation from './surfaces/SectorRotation'
import PortfolioImpact from './surfaces/PortfolioImpact'
import ActionPlan from './surfaces/ActionPlan'

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mb-6">
        <p className="text-sm font-medium text-muted-foreground">Public Markets</p>
        <h1 className="text-3xl font-semibold tracking-tight">Macro Market Briefing</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">Macro strategy workspace for rates, inflation, GDP, Fed policy, sector rotation, global risks, and portfolio action plans backed by Prisma and SQLite.</p>
      </div>
      <Tabs defaultValue="macro_dashboard">
        <TabsList>
          <TabsTrigger value="macro_dashboard">Macro Dashboard</TabsTrigger>
          <TabsTrigger value="sector_rotation">Sector Rotation</TabsTrigger>
          <TabsTrigger value="portfolio_impact">Portfolio Impact</TabsTrigger>
          <TabsTrigger value="action_plan">Action Plan</TabsTrigger>
        </TabsList>
        <TabsContent value="macro_dashboard"><MacroDashboard /></TabsContent>
        <TabsContent value="sector_rotation"><SectorRotation /></TabsContent>
        <TabsContent value="portfolio_impact"><PortfolioImpact /></TabsContent>
        <TabsContent value="action_plan"><ActionPlan /></TabsContent>
      </Tabs>
    </div>
  )
}
