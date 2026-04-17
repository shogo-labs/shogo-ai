import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import DailyPlanner from './surfaces/DailyPlanner'
import Journal from './surfaces/Journal'

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <Tabs defaultValue="daily_planner">
        <TabsList>
          <TabsTrigger value="daily_planner">Daily Planner</TabsTrigger>
          <TabsTrigger value="journal">Journal</TabsTrigger>
        </TabsList>
        <TabsContent value="daily_planner"><DailyPlanner /></TabsContent>
        <TabsContent value="journal"><Journal /></TabsContent>
      </Tabs>
    </div>
  )
}
