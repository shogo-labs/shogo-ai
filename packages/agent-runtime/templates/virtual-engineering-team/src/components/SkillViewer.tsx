import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { SkillDoc } from '@/lib/vet-api'

interface Props {
  skill: SkillDoc | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function SkillViewer({ skill, open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle className="font-mono">{skill?.name ?? ''}</DialogTitle>
            {skill?.isCore && <Badge>core</Badge>}
            {skill && <Badge variant="outline">{skill.role}</Badge>}
            {skill && <Badge variant="outline">{skill.stage}</Badge>}
          </div>
          <DialogDescription>
            {skill && (
              <a
                href={skill.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs underline break-all"
              >
                {skill.sourceUrl}
              </a>
            )}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="h-[60vh] rounded-md border bg-muted/30 p-4">
          <pre className="whitespace-pre-wrap text-xs font-mono leading-relaxed">
            {skill?.body ?? ''}
          </pre>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
