import { Card, CardContent } from '@/components/ui/card'

interface MetricCardProps {
  label: string
  value: string | number
  unit?: string
}

export function MetricCard({ label, value, unit }: MetricCardProps) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-2xl font-bold">
          {unit === '$' && '$'}{value}{unit && unit !== '$' && ` ${unit}`}
        </p>
      </CardContent>
    </Card>
  )
}
