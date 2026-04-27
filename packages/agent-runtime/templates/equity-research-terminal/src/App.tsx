import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import Screener from './surfaces/Screener'
import ValuationMemo from './surfaces/ValuationMemo'
import CompetitiveLandscape from './surfaces/CompetitiveLandscape'
import EarningsNotes from './surfaces/EarningsNotes'

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mb-6">
        <p className="text-sm font-medium text-muted-foreground">Public Markets</p>
        <h1 className="text-3xl font-semibold tracking-tight">Equity Research Terminal</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">Public-market equity research workspace for stock screening, DCF valuation, earnings notes, and competitive analysis backed by Prisma and SQLite.</p>
      </div>
      <Tabs defaultValue="screener">
        <TabsList>
          <TabsTrigger value="screener">Screener</TabsTrigger>
          <TabsTrigger value="valuation_memo">Valuation Memo</TabsTrigger>
          <TabsTrigger value="competitive_landscape">Competitive Landscape</TabsTrigger>
          <TabsTrigger value="earnings_notes">Earnings Notes</TabsTrigger>
        </TabsList>
        <TabsContent value="screener"><Screener /></TabsContent>
        <TabsContent value="valuation_memo"><ValuationMemo /></TabsContent>
        <TabsContent value="competitive_landscape"><CompetitiveLandscape /></TabsContent>
        <TabsContent value="earnings_notes"><EarningsNotes /></TabsContent>
      </Tabs>
    </div>
  )
}
