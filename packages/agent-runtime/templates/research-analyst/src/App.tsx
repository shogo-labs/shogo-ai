import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import ResearchDashboard from './surfaces/ResearchDashboard'
import TopicTracker from './surfaces/TopicTracker'

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <Tabs defaultValue="research_dashboard">
        <TabsList>
          <TabsTrigger value="research_dashboard">Research Dashboard</TabsTrigger>
          <TabsTrigger value="topic_tracker">Topic Tracker</TabsTrigger>
        </TabsList>
        <TabsContent value="research_dashboard"><ResearchDashboard /></TabsContent>
        <TabsContent value="topic_tracker"><TopicTracker /></TabsContent>
      </Tabs>
    </div>
  )
}
