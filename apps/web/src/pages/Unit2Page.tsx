import { WavesmithMetaDemo } from '../components/Unit2_WavesmithMetaSystem/WavesmithMetaDemo'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'

export function Unit2Page() {
  return (
    <div className="p-8 max-w-[1600px] mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Unit 2: Wavesmith Meta-System in Browser</h1>
        <p className="text-lg text-muted-foreground">
          Complete transformation pipeline: ArkType Schema → Enhanced JSON Schema → MST Models → Runtime Store
        </p>
      </div>

      <Card className="mb-8 border-2 border-green-500 bg-green-500/10">
        <CardHeader className="pb-2">
          <CardTitle className="text-green-600">✅ System Status: Tier 1 Loaded</CardTitle>
          <CardDescription>
            <strong>11 TypeScript files</strong> loaded from source using Vite ?raw imports:
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="list-disc pl-6 text-sm space-y-1">
            <li><strong>Schematic Layer (3 files):</strong> arktype-to-json-schema, enhanced-json-schema-to-mst, index</li>
            <li><strong>Meta Layer (4 files):</strong> meta-registry, meta-store, bootstrap, meta-helpers</li>
            <li><strong>Core Layer (2 files):</strong> types, index</li>
            <li><strong>Utils Layer (1 file):</strong> string utilities</li>
            <li><strong>Main Entry (1 file):</strong> package exports</li>
          </ul>
        </CardContent>
      </Card>

      <WavesmithMetaDemo />

      <Card className="mt-12 bg-muted">
        <CardHeader>
          <CardTitle>Architecture Deep Dive</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-sm">
          <div>
            <h4 className="font-semibold text-primary mb-2">Transformation Pipeline</h4>
            <ol className="list-decimal pl-6 space-y-1">
              <li><strong>ArkType Schema Definition</strong> - Define schemas using arktype.scope()</li>
              <li><strong>Schema Extraction</strong> - Extract Enhanced JSON Schema with computed properties and references</li>
              <li><strong>MST Model Generation</strong> - Generate reactive MobX-State-Tree models with type safety</li>
              <li><strong>Runtime Store Creation</strong> - Instantiate stores with collections and CRUD operations</li>
            </ol>
          </div>

          <div>
            <h4 className="font-semibold text-purple-500 mb-2">Key Features Demonstrated</h4>
            <ul className="list-disc pl-6 space-y-1">
              <li>Zero inline strings - all files loaded via ?raw imports</li>
              <li>Full TypeScript type inference and validation</li>
              <li>Reactive state management with MobX observers</li>
              <li>Schema-driven runtime code generation</li>
              <li>Browser-native execution (no Node.js filesystem dependencies)</li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-orange-500 mb-2">Next Steps (Tier 2 & 3)</h4>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Tier 2:</strong> View system (query/template views), persistence abstractions</li>
              <li><strong>Tier 3:</strong> Behavioral system, browser persistence (localStorage/IndexedDB)</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
