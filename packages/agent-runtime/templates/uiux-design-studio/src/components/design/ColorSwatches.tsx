import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { ColorPalette } from './types'

interface Props {
  palette: ColorPalette
}

export default function ColorSwatches({ palette }: Props) {
  const [copiedToken, setCopiedToken] = useState<string | null>(null)

  const handleCopy = (hex: string, name: string) => {
    navigator.clipboard.writeText(hex)
    setCopiedToken(name)
    setTimeout(() => setCopiedToken(null), 1500)
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{palette.name}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {palette.tokens.map((token) => (
            <button
              key={token.name}
              onClick={() => handleCopy(token.light, token.name)}
              className="group cursor-pointer text-left space-y-1.5"
            >
              <div
                className="h-16 rounded-lg border border-border transition-all duration-200 group-hover:scale-105 group-hover:shadow-md"
                style={{ backgroundColor: token.light }}
              />
              <div className="space-y-0.5">
                <p className="text-xs font-medium text-foreground truncate">{token.name}</p>
                <p className="text-[10px] font-mono text-muted-foreground uppercase">
                  {copiedToken === token.name ? 'Copied!' : token.light}
                </p>
              </div>
              {token.dark !== token.light && (
                <Badge variant="outline" className="text-[9px] px-1 py-0">
                  dark: {token.dark}
                </Badge>
              )}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
