import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import HealthDashboard from './surfaces/HealthDashboard'
import AlertFeed from './surfaces/AlertFeed'

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <Tabs defaultValue="health_dashboard">
        <TabsList>
          <TabsTrigger value="health_dashboard">Health Dashboard</TabsTrigger>
          <TabsTrigger value="alert_feed">Alert Feed</TabsTrigger>
        </TabsList>
        <TabsContent value="health_dashboard"><HealthDashboard /></TabsContent>
        <TabsContent value="alert_feed"><AlertFeed /></TabsContent>
      </Tabs>
    </div>
  )
}
