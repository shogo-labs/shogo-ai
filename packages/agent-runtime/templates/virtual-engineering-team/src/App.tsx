import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import SprintBoard from './surfaces/SprintBoard'
import RolesPanel from './surfaces/RolesPanel'
import SkillsRegistry from './surfaces/SkillsRegistry'

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <Tabs defaultValue="sprint_board">
        <TabsList>
          <TabsTrigger value="sprint_board">Sprint Board</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
          <TabsTrigger value="skills_registry">Skills Registry</TabsTrigger>
        </TabsList>
        <TabsContent value="sprint_board"><SprintBoard /></TabsContent>
        <TabsContent value="roles"><RolesPanel /></TabsContent>
        <TabsContent value="skills_registry"><SkillsRegistry /></TabsContent>
      </Tabs>
    </div>
  )
}
