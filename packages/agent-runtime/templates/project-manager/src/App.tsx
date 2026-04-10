import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import SprintBoard from './surfaces/SprintBoard'
import StandupSummary from './surfaces/StandupSummary'

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <Tabs defaultValue="sprint_board">
        <TabsList>
          <TabsTrigger value="sprint_board">Sprint Board</TabsTrigger>
          <TabsTrigger value="standup_summary">Standup Summary</TabsTrigger>
        </TabsList>
        <TabsContent value="sprint_board"><SprintBoard /></TabsContent>
        <TabsContent value="standup_summary"><StandupSummary /></TabsContent>
      </Tabs>
    </div>
  )
}
