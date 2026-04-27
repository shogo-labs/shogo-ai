import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import TechnicalReportCard from './surfaces/TechnicalReportCard'
import SignalLog from './surfaces/SignalLog'
import QuantPatternFinder from './surfaces/QuantPatternFinder'
import TradePlan from './surfaces/TradePlan'

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mb-6">
        <p className="text-sm font-medium text-muted-foreground">Public Markets</p>
        <h1 className="text-3xl font-semibold tracking-tight">Technical Quant Lab</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">Technical and quantitative research lab for indicator snapshots, chart levels, pattern signals, options activity, and trade plans backed by Prisma and SQLite.</p>
      </div>
      <Tabs defaultValue="technical_report_card">
        <TabsList>
          <TabsTrigger value="technical_report_card">Technical Report Card</TabsTrigger>
          <TabsTrigger value="signal_log">Signal Log</TabsTrigger>
          <TabsTrigger value="quant_pattern_finder">Quant Pattern Finder</TabsTrigger>
          <TabsTrigger value="trade_plan">Trade Plan</TabsTrigger>
        </TabsList>
        <TabsContent value="technical_report_card"><TechnicalReportCard /></TabsContent>
        <TabsContent value="signal_log"><SignalLog /></TabsContent>
        <TabsContent value="quant_pattern_finder"><QuantPatternFinder /></TabsContent>
        <TabsContent value="trade_plan"><TradePlan /></TabsContent>
      </Tabs>
    </div>
  )
}
