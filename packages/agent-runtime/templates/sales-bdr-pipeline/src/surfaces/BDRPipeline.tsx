import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { MetricCard } from '@/components/MetricCard'
import initialData from './BDRPipeline.data.json'

interface Lead {
  id?: string
  name?: string
  role?: string
  company?: string
  companySize?: string
  stage?: string
  fundingDate?: string
  location?: string
  email?: string
  linkedin?: string
  recentSignal?: string
  signalSource?: string
  opener?: string
  draftStatus?: 'none' | 'drafting' | 'queued' | 'sent' | 'replied' | 'bounced'
  gmailDraftId?: string
  notes?: string
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  none: 'outline',
  drafting: 'secondary',
  queued: 'default',
  sent: 'default',
  replied: 'default',
  bounced: 'destructive',
}

export default function BDRPipeline() {
  const [data] = useState(initialData as { metrics: Record<string, string>; leads: Lead[] })
  const leads = data.leads ?? []

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">BDR Pipeline</h2>
            <p className="text-sm text-muted-foreground">
              Researched accounts, enriched leads, and queued Gmail drafts.
            </p>
          </div>
          <Badge variant="outline">Connect Gmail to queue drafts</Badge>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <MetricCard label="Leads" value={data.metrics.leads} />
          <MetricCard label="Enriched" value={data.metrics.enriched} />
          <MetricCard label="Drafted" value={data.metrics.drafted} />
          <MetricCard label="Drafts Queued" value={data.metrics.queued} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Pipeline</CardTitle>
          </CardHeader>
          <CardContent>
            {leads.length === 0 ? (
              <div className="flex flex-col items-start gap-2 py-8">
                <p className="text-sm text-muted-foreground">
                  No leads yet. Tell me your ICP — for example, &quot;Pull 50 Series A
                  SaaS founders in NY who raised in the last 6 months&quot; — and I&apos;ll
                  research, enrich, draft personalized openers, and queue Gmail
                  drafts for your review.
                </p>
                <p className="text-xs text-muted-foreground">
                  Hover any row once populated to see the full personalized opener.
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Signal</TableHead>
                    <TableHead>Draft</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leads.map((lead, i) => {
                    const status = lead.draftStatus ?? 'none'
                    return (
                      <Tooltip key={lead.id ?? i}>
                        <TooltipTrigger asChild>
                          <TableRow className="cursor-default">
                            <TableCell className="font-medium">{lead.name ?? '—'}</TableCell>
                            <TableCell>{lead.role ?? '—'}</TableCell>
                            <TableCell>{lead.company ?? '—'}</TableCell>
                            <TableCell>{lead.stage ?? '—'}</TableCell>
                            <TableCell>{lead.location ?? '—'}</TableCell>
                            <TableCell className="max-w-[260px] truncate">
                              {lead.recentSignal ?? '—'}
                            </TableCell>
                            <TableCell>
                              <Badge variant={STATUS_VARIANT[status] ?? 'outline'}>
                                {status}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-md whitespace-pre-wrap text-sm">
                          {lead.opener ? (
                            <div className="flex flex-col gap-2">
                              <p>{lead.opener}</p>
                              {lead.signalSource && (
                                <p className="text-xs text-muted-foreground">
                                  Source: {lead.signalSource}
                                </p>
                              )}
                            </div>
                          ) : (
                            <p>No personalized opener drafted yet.</p>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  )
}
