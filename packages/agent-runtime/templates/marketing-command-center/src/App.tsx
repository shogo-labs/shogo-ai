import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import SeoDashboard from './surfaces/SeoDashboard'
import ContentHub from './surfaces/ContentHub'
import CompetitorWatch from './surfaces/CompetitorWatch'

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <Tabs defaultValue="seo_dashboard">
        <TabsList>
          <TabsTrigger value="seo_dashboard">SEO Dashboard</TabsTrigger>
          <TabsTrigger value="content_hub">Content Hub</TabsTrigger>
          <TabsTrigger value="competitor_watch">Competitor Watch</TabsTrigger>
        </TabsList>
        <TabsContent value="seo_dashboard"><SeoDashboard /></TabsContent>
        <TabsContent value="content_hub"><ContentHub /></TabsContent>
        <TabsContent value="competitor_watch"><CompetitorWatch /></TabsContent>
      </Tabs>
    </div>
  )
}
