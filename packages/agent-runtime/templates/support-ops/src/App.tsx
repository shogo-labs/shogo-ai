import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import TicketQueue from './surfaces/TicketQueue'
import IncidentTracker from './surfaces/IncidentTracker'

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <Tabs defaultValue="ticket_queue">
        <TabsList>
          <TabsTrigger value="ticket_queue">Ticket Queue</TabsTrigger>
          <TabsTrigger value="incident_tracker">Incident Tracker</TabsTrigger>
        </TabsList>
        <TabsContent value="ticket_queue"><TicketQueue /></TabsContent>
        <TabsContent value="incident_tracker"><IncidentTracker /></TabsContent>
      </Tabs>
    </div>
  )
}
