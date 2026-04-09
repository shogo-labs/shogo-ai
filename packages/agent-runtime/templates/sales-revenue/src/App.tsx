import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import SalesPipeline from './surfaces/SalesPipeline'
import RevenueDashboard from './surfaces/RevenueDashboard'

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <Tabs defaultValue="sales_pipeline">
        <TabsList>
          <TabsTrigger value="sales_pipeline">Sales Pipeline</TabsTrigger>
          <TabsTrigger value="revenue_dashboard">Revenue Dashboard</TabsTrigger>
        </TabsList>
        <TabsContent value="sales_pipeline"><SalesPipeline /></TabsContent>
        <TabsContent value="revenue_dashboard"><RevenueDashboard /></TabsContent>
      </Tabs>
    </div>
  )
}
