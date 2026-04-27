import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import PortfolioOverview from './surfaces/PortfolioOverview'
import RiskHeatmap from './surfaces/RiskHeatmap'
import StressTests from './surfaces/StressTests'
import RebalancePlan from './surfaces/RebalancePlan'

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mb-6">
        <p className="text-sm font-medium text-muted-foreground">Public Markets</p>
        <h1 className="text-3xl font-semibold tracking-tight">Portfolio Risk Desk</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">Portfolio risk and allocation command center for holdings, stress tests, rebalancing actions, and macro assumptions backed by Prisma and SQLite.</p>
      </div>
      <Tabs defaultValue="portfolio_overview">
        <TabsList>
          <TabsTrigger value="portfolio_overview">Portfolio Overview</TabsTrigger>
          <TabsTrigger value="risk_heatmap">Risk Heatmap</TabsTrigger>
          <TabsTrigger value="stress_tests">Stress Tests</TabsTrigger>
          <TabsTrigger value="rebalance_plan">Rebalance Plan</TabsTrigger>
        </TabsList>
        <TabsContent value="portfolio_overview"><PortfolioOverview /></TabsContent>
        <TabsContent value="risk_heatmap"><RiskHeatmap /></TabsContent>
        <TabsContent value="stress_tests"><StressTests /></TabsContent>
        <TabsContent value="rebalance_plan"><RebalancePlan /></TabsContent>
      </Tabs>
    </div>
  )
}
