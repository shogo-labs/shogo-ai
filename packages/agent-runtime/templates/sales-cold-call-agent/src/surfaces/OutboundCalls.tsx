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
import { ScrollArea } from '@/components/ui/scroll-area'
import { MetricCard } from '@/components/MetricCard'
import initialData from './OutboundCalls.data.json'

type CallStatus =
  | 'queued'
  | 'dialing'
  | 'connected'
  | 'voicemail'
  | 'no_answer'
  | 'not_interested'
  | 'do_not_call'
  | 'demo_booked'
  | 'callback_requested'
  | 'failed'

interface CallRow {
  id?: string
  name?: string
  company?: string
  phone?: string
  timezone?: string
  status?: CallStatus
  disposition?: string
  qualificationNotes?: string
  demoSlot?: string
  attempts?: number
  lastError?: string
}

interface TranscriptLine {
  speaker?: 'agent' | 'prospect'
  text?: string
  ts?: string
}

const STATUS_VARIANT: Record<CallStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  queued: 'outline',
  dialing: 'secondary',
  connected: 'secondary',
  voicemail: 'outline',
  no_answer: 'outline',
  not_interested: 'outline',
  do_not_call: 'destructive',
  demo_booked: 'default',
  callback_requested: 'default',
  failed: 'destructive',
}

const STATUS_LABEL: Record<CallStatus, string> = {
  queued: 'Queued',
  dialing: 'Dialing…',
  connected: 'Connected',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
  not_interested: 'Not interested',
  do_not_call: 'Do not call',
  demo_booked: 'Demo booked',
  callback_requested: 'Callback',
  failed: 'Failed',
}

export default function OutboundCalls() {
  const [data] = useState(
    initialData as {
      metrics: Record<string, string>
      calls: CallRow[]
      activeCallId: string | null
      liveTranscript: TranscriptLine[]
    },
  )
  const calls = data.calls ?? []
  const transcript = data.liveTranscript ?? []
  const activeCall = calls.find((c) => c.id === data.activeCallId) ?? null

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Outbound Calls</h2>
          <p className="text-sm text-muted-foreground">
            Twilio + ElevenLabs cold-call agent. Disclose AI, qualify, book demos.
          </p>
        </div>
        <Badge variant="outline">Connect Twilio + ElevenLabs to start</Badge>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <MetricCard label="Queued" value={data.metrics.queued} />
        <MetricCard label="In flight" value={data.metrics.inflight} />
        <MetricCard label="Connected" value={data.metrics.connected} />
        <MetricCard label="Demos booked" value={data.metrics.demoBooked} />
      </div>

      <div className="grid grid-cols-3 gap-6">
        <Card className="col-span-2">
          <CardHeader>
            <CardTitle>Call Queue</CardTitle>
          </CardHeader>
          <CardContent>
            {calls.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No calls queued. Import leads from the BDR Pipeline or paste a list,
                then say &quot;start calling&quot; to dial.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {calls.map((c, i) => {
                    const status = (c.status ?? 'queued') as CallStatus
                    return (
                      <TableRow key={c.id ?? i}>
                        <TableCell className="font-medium">{c.name ?? '—'}</TableCell>
                        <TableCell>{c.company ?? '—'}</TableCell>
                        <TableCell>{c.phone ?? '—'}</TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[status]}>
                            {STATUS_LABEL[status]}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[260px] truncate">
                          {c.qualificationNotes ?? c.disposition ?? '—'}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Live Transcript</CardTitle>
          </CardHeader>
          <CardContent>
            {activeCall ? (
              <div className="mb-3 flex flex-col gap-1">
                <p className="text-sm font-medium">
                  {activeCall.name ?? 'Prospect'} — {activeCall.company ?? ''}
                </p>
                <Badge variant="secondary" className="w-fit">
                  {STATUS_LABEL[(activeCall.status ?? 'connected') as CallStatus]}
                </Badge>
              </div>
            ) : null}
            <ScrollArea className="h-[320px] pr-3">
              {transcript.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No active call. The transcript will stream here when a call connects.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {transcript.map((line, i) => (
                    <div key={i} className="flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {line.speaker ?? 'agent'} {line.ts ? `· ${line.ts}` : ''}
                      </span>
                      <span className="text-sm">{line.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
