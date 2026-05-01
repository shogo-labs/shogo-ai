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
import { MetricCard } from '@/components/MetricCard'
import initialData from './RevenueOps.data.json'

interface ChurnRow {
  id?: string
  customer?: string
  email?: string
  mrr?: string
  signals?: string[]
  evidence?: string[]
}

interface RefundRow {
  id?: string
  customer?: string
  chargeId?: string
  amount?: string
  reason?: string
  status?: 'preview' | 'pending' | 'succeeded' | 'failed'
}

interface ReceiptRow {
  id?: string
  refundId?: string
  customer?: string
  amount?: string
  reason?: string
  mode?: 'test' | 'live'
  approver?: string
  timestamp?: string
}

const REFUND_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  preview: 'outline',
  pending: 'secondary',
  succeeded: 'default',
  failed: 'destructive',
}

export default function RevenueOps() {
  const [data] = useState(
    initialData as {
      mode: 'test' | 'live'
      metrics: Record<string, string>
      churnRisk: ChurnRow[]
      refundQueue: RefundRow[]
      receipts: ReceiptRow[]
    },
  )

  const churn = data.churnRisk ?? []
  const queue = data.refundQueue ?? []
  const receipts = data.receipts ?? []

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Stripe Revenue Ops</h2>
          <p className="text-sm text-muted-foreground">
            Live Stripe metrics, churn risk, and refund execution with receipts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={data.mode === 'live' ? 'destructive' : 'secondary'}>
            Stripe: {data.mode === 'live' ? 'LIVE' : 'TEST'}
          </Badge>
          <Badge variant="outline">Connect Stripe to populate</Badge>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-4">
        <MetricCard label="MRR" value={data.metrics.mrr} unit="$" />
        <MetricCard label="Balance" value={data.metrics.balance} unit="$" />
        <MetricCard label="Pending" value={data.metrics.pending} />
        <MetricCard label="Customers" value={data.metrics.customers} />
        <MetricCard label="Failed payments" value={data.metrics.failedPayments} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Churn Risk This Month</CardTitle>
        </CardHeader>
        <CardContent>
          {churn.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No flagged customers yet. Once Stripe and your support inbox are
              connected, customers with 2+ support contacts, failed payments, or
              spend drops will surface here with audit evidence.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>MRR</TableHead>
                  <TableHead>Signals</TableHead>
                  <TableHead>Evidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {churn.map((c, i) => (
                  <TableRow key={c.id ?? i}>
                    <TableCell className="font-medium">{c.customer ?? '—'}</TableCell>
                    <TableCell>{c.email ?? '—'}</TableCell>
                    <TableCell>{c.mrr ?? '—'}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(c.signals ?? []).map((s, j) => (
                          <Badge key={j} variant="outline">
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate text-xs text-muted-foreground">
                      {(c.evidence ?? []).join(', ') || '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Refund Execution</CardTitle>
          </CardHeader>
          <CardContent>
            {queue.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No refunds pending. Tell me which churn-risk customers to refund and
                I&apos;ll preview totals and wait for explicit confirmation before
                running.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.map((r, i) => {
                    const status = r.status ?? 'preview'
                    return (
                      <TableRow key={r.id ?? i}>
                        <TableCell className="font-medium">{r.customer ?? '—'}</TableCell>
                        <TableCell>{r.amount ?? '—'}</TableCell>
                        <TableCell className="max-w-[200px] truncate">
                          {r.reason ?? '—'}
                        </TableCell>
                        <TableCell>
                          <Badge variant={REFUND_VARIANT[status] ?? 'outline'}>{status}</Badge>
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
            <CardTitle>Refund Receipts</CardTitle>
          </CardHeader>
          <CardContent>
            {receipts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No refunds executed yet. Every refund logs a receipt here with the
                Stripe refund id, mode, approver, and timestamp.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Refund</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {receipts.map((r, i) => (
                    <TableRow key={r.id ?? i}>
                      <TableCell className="font-mono text-xs">
                        {r.refundId ?? '—'}
                      </TableCell>
                      <TableCell>{r.customer ?? '—'}</TableCell>
                      <TableCell>{r.amount ?? '—'}</TableCell>
                      <TableCell>
                        <Badge
                          variant={r.mode === 'live' ? 'destructive' : 'secondary'}
                        >
                          {r.mode ?? 'test'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.timestamp ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
