import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { Artifact } from '@/lib/vet-api'

interface Props {
  artifact: Artifact
  onClick: () => void
}

export default function ArtifactCard({ artifact, onClick }: Props) {
  return (
    <Card onClick={onClick} className="cursor-pointer hover:border-primary/50 transition-colors">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium leading-tight">{artifact.title}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge variant="outline" className="text-[10px]">{artifact.role}</Badge>
          <Badge variant="secondary" className="text-[10px]">{artifact.kind}</Badge>
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2">
          {artifact.content.slice(0, 140)}{artifact.content.length > 140 ? '…' : ''}
        </p>
      </CardContent>
    </Card>
  )
}
