import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import DailyPlan from './surfaces/DailyPlan'
import ReviewPanel from './surfaces/ReviewPanel'
import DecisionLog from './surfaces/DecisionLog'

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <Tabs defaultValue="daily_plan">
        <TabsList>
          <TabsTrigger value="daily_plan">Daily Plan</TabsTrigger>
          <TabsTrigger value="review_panel">Review Panel</TabsTrigger>
          <TabsTrigger value="decision_log">Decision Log</TabsTrigger>
        </TabsList>
        <TabsContent value="daily_plan"><DailyPlan /></TabsContent>
        <TabsContent value="review_panel"><ReviewPanel /></TabsContent>
        <TabsContent value="decision_log"><DecisionLog /></TabsContent>
      </Tabs>
    </div>
  )
}
