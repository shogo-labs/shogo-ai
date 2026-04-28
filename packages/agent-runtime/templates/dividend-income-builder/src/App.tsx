import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import DividendBlueprint from './surfaces/DividendBlueprint'
import IncomeProjection from './surfaces/IncomeProjection'
import SafetyScores from './surfaces/SafetyScores'
import DripScenario from './surfaces/DripScenario'

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mb-6">
        <p className="text-sm font-medium text-muted-foreground">Public Markets</p>
        <h1 className="text-3xl font-semibold tracking-tight">Dividend Income Builder</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">Dividend portfolio workspace for income candidates, safety scoring, payout checks, DRIP projections, and tax notes backed by Prisma and SQLite.</p>
      </div>
      <Tabs defaultValue="dividend_blueprint">
        <TabsList>
          <TabsTrigger value="dividend_blueprint">Dividend Blueprint</TabsTrigger>
          <TabsTrigger value="income_projection">Income Projection</TabsTrigger>
          <TabsTrigger value="safety_scores">Safety Scores</TabsTrigger>
          <TabsTrigger value="drip_scenario">Drip Scenario</TabsTrigger>
        </TabsList>
        <TabsContent value="dividend_blueprint"><DividendBlueprint /></TabsContent>
        <TabsContent value="income_projection"><IncomeProjection /></TabsContent>
        <TabsContent value="safety_scores"><SafetyScores /></TabsContent>
        <TabsContent value="drip_scenario"><DripScenario /></TabsContent>
      </Tabs>
    </div>
  )
}
