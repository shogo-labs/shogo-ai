import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { CoverageItem } from './types'

function CoverageCell({ covered }: { covered: boolean }) {
  return (
    <td className="px-3 py-2 text-center">
      {covered ? (
        <span className="text-emerald-500">✓</span>
      ) : (
        <span className="text-zinc-500">—</span>
      )}
    </td>
  )
}

interface CoverageMatrixProps {
  items: CoverageItem[]
}

export function CoverageMatrix({ items }: CoverageMatrixProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-16">
        <p className="text-lg font-medium text-muted-foreground">No coverage data</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Run tests to start tracking feature coverage.
        </p>
      </div>
    )
  }

  const totalCells = items.length * 5
  const coveredCells = items.reduce((sum, item) => {
    return (
      sum +
      (item.happyPath ? 1 : 0) +
      (item.edgeCases ? 1 : 0) +
      (item.errorStates ? 1 : 0) +
      (item.responsive ? 1 : 0) +
      (item.accessibility ? 1 : 0)
    )
  }, 0)
  const coveragePercent = Math.round((coveredCells / totalCells) * 100)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Feature Coverage</CardTitle>
          <span className="text-sm text-muted-foreground">{coveragePercent}% covered</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Feature</th>
                <th className="px-3 pb-2 text-center font-medium">Happy Path</th>
                <th className="px-3 pb-2 text-center font-medium">Edge Cases</th>
                <th className="px-3 pb-2 text-center font-medium">Errors</th>
                <th className="px-3 pb-2 text-center font-medium">Responsive</th>
                <th className="px-3 pb-2 text-center font-medium">A11y</th>
                <th className="px-3 pb-2 text-center font-medium">Last Tested</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={i} className="border-b border-border/50">
                  <td className="py-2 pr-4 font-medium">{item.feature}</td>
                  <CoverageCell covered={item.happyPath} />
                  <CoverageCell covered={item.edgeCases} />
                  <CoverageCell covered={item.errorStates} />
                  <CoverageCell covered={item.responsive} />
                  <CoverageCell covered={item.accessibility} />
                  <td className="px-3 py-2 text-center text-xs text-muted-foreground">
                    {item.lastTested || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}
