import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { TypographyPairing } from './types'

interface Props {
  typography: TypographyPairing
}

const PREVIEW_SIZES = [
  { label: 'H1', className: 'text-4xl font-bold', text: 'The quick brown fox' },
  { label: 'H2', className: 'text-3xl font-semibold', text: 'Jumps over the lazy dog' },
  { label: 'H3', className: 'text-2xl font-semibold', text: 'Pack my box with five dozen' },
  { label: 'H4', className: 'text-xl font-medium', text: 'Liquor jugs' },
]

export default function TypographyPreview({ typography }: Props) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Typography Pairing</CardTitle>
          <div className="flex gap-1.5">
            <Badge variant="outline" className="text-[10px]">heading</Badge>
            <Badge variant="outline" className="text-[10px]">body</Badge>
            <Badge variant="outline" className="text-[10px]">mono</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <FontCard label="Heading" font={typography.heading} />
          <FontCard label="Body" font={typography.body} />
          <FontCard label="Mono" font={typography.mono} />
        </div>

        <div className="space-y-4 pt-2 border-t border-border">
          <p className="text-xs text-muted-foreground pt-2">Heading scale preview</p>
          {PREVIEW_SIZES.map((size) => (
            <div key={size.label} className="flex items-baseline gap-3">
              <span className="text-xs font-mono text-muted-foreground w-8 shrink-0">
                {size.label}
              </span>
              <p
                className={size.className}
                style={{ fontFamily: typography.heading.family }}
              >
                {size.text}
              </p>
            </div>
          ))}
        </div>

        <div className="space-y-3 pt-2 border-t border-border">
          <p className="text-xs text-muted-foreground pt-2">Body text preview</p>
          <p
            className="text-base leading-relaxed"
            style={{ fontFamily: typography.body.family }}
          >
            Good typography is invisible. Great typography is felt. The reader should
            never notice the typeface — only the meaning it carries. Body text at 16px
            with 1.6 line-height and -0.011em letter-spacing delivers the optimal
            reading experience across screen sizes.
          </p>
          <pre
            className="text-sm p-3 rounded-md bg-muted font-mono"
            style={{ fontFamily: typography.mono.family }}
          >
            {`const designSystem = await generateSystem({\n  industry: 'fintech',\n  style: 'glassmorphism',\n  palette: 'ocean-depth'\n})`}
          </pre>
        </div>
      </CardContent>
    </Card>
  )
}

function FontCard({ label, font }: { label: string; font: { family: string; googleFontsUrl: string; fallback: string } }) {
  return (
    <div className="space-y-2 p-3 rounded-lg border border-border">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold" style={{ fontFamily: font.family }}>
        {font.family}
      </p>
      <p className="text-[10px] font-mono text-muted-foreground break-all">
        {font.fallback}
      </p>
    </div>
  )
}
