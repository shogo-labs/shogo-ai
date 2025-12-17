import { Link } from 'react-router-dom'
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export function HomePage() {
  return (
    <div className="p-8 max-w-[1400px] mx-auto">
      <h1 className="text-3xl font-bold mb-2">Wavesmith State API - Browser Integration</h1>
      <p className="text-lg text-muted-foreground mb-12">
        Progressive implementation: Node.js runtime → TypeScript execution → Meta-system pipeline
      </p>

      <Card className="mb-4">
        <CardHeader className="py-4">
          <CardTitle className="text-base">✅ Unit 0: Front-end Scaffold - Complete</CardTitle>
          <CardDescription>
            React + Vite + Sandpack infrastructure in place
          </CardDescription>
        </CardHeader>
      </Card>

      <Card className="mb-4">
        <CardHeader className="py-4">
          <CardTitle className="text-base">✅ Unit 1: Nodebox Integration - Complete</CardTitle>
          <CardDescription>
            Node.js execution, virtual filesystem, and wavesmith dependencies working in browser
          </CardDescription>
        </CardHeader>
      </Card>

      <Card className="mb-4">
        <CardHeader className="py-4">
          <CardTitle className="text-base">✅ Unit 1.5: TypeScript Loading - Complete</CardTitle>
          <CardDescription>
            TypeScript executes in browser using vite-react-ts template with Vite bundler
          </CardDescription>
        </CardHeader>
      </Card>

      <Card className="mb-4 border-2 border-primary bg-primary/10">
        <CardHeader className="py-4">
          <CardTitle className="text-base">🔄 Unit 2: Wavesmith Meta-System - In Progress</CardTitle>
          <CardDescription className="mb-4">
            Loading complete meta-system (11 files): Schema transformation pipeline in browser
          </CardDescription>
          <Button asChild>
            <Link to="/unit2">Open Unit 2 Demo →</Link>
          </Button>
        </CardHeader>
      </Card>

      <Card className="mt-12 bg-muted">
        <CardHeader>
          <CardTitle className="text-base">Legacy Test Components</CardTitle>
          <CardDescription className="mb-4">
            Foundational tests from Unit 0, 1, and 1.5 (kept for reference)
          </CardDescription>
          <Button variant="secondary" asChild>
            <Link to="/legacy-tests">View Legacy Tests</Link>
          </Button>
        </CardHeader>
      </Card>
    </div>
  )
}
