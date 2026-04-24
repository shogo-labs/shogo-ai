import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Artifact } from '@/lib/vet-api'

interface Props {
  artifact: Artifact | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function ArtifactViewer({ artifact, open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{artifact?.title ?? ''}</DialogTitle>
          <DialogDescription>
            <div className="flex flex-wrap gap-1 mt-1">
              {artifact && <Badge variant="outline">{artifact.stage}</Badge>}
              {artifact && <Badge variant="outline">{artifact.role}</Badge>}
              {artifact && <Badge variant="secondary">{artifact.kind}</Badge>}
            </div>
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="h-[55vh] rounded-md border bg-muted/30 p-4">
          <pre className="whitespace-pre-wrap text-sm leading-relaxed">
            {artifact?.content ?? ''}
          </pre>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
