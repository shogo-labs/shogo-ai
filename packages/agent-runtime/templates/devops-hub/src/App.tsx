import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import PrQueue from './surfaces/PrQueue'
import TeamActivity from './surfaces/TeamActivity'
import ReleaseNotes from './surfaces/ReleaseNotes'

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <Tabs defaultValue="pr_queue">
        <TabsList>
          <TabsTrigger value="pr_queue">PR Queue</TabsTrigger>
          <TabsTrigger value="team_activity">Team Activity</TabsTrigger>
          <TabsTrigger value="release_notes">Release Notes</TabsTrigger>
        </TabsList>
        <TabsContent value="pr_queue"><PrQueue /></TabsContent>
        <TabsContent value="team_activity"><TeamActivity /></TabsContent>
        <TabsContent value="release_notes"><ReleaseNotes /></TabsContent>
      </Tabs>
    </div>
  )
}
