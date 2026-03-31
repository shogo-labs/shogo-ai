// Ticket Queue

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="Ticket Queue" variant="h2" />
      <DynBadge text="Connect ticketing tool" variant="outline" />
    </Row>
    <Grid columns={4}>
      <Metric label="Open" value={data.metrics.open} />
      <Metric label="Resolved (7d)" value={data.metrics.resolved} />
      <Metric label="Avg Response" value={data.metrics.responseTime} />
      <Metric label="CSAT" value={data.metrics.csat} />
    </Grid>
    <CanvasCard title="Tickets by Priority">
      <Column gap="sm">
        <Row align="center" gap="sm">
          <DynBadge text="P0 Critical" variant="destructive" />
          <DynText text="Immediate alert + escalation" variant="muted" />
        </Row>
        <Row align="center" gap="sm">
          <DynBadge text="P1 High" variant="default" />
          <DynText text="Alert within 15 minutes" variant="muted" />
        </Row>
        <Row align="center" gap="sm">
          <DynBadge text="P2 Medium" variant="secondary" />
          <DynText text="Included in daily digest" variant="muted" />
        </Row>
      </Column>
    </CanvasCard>
    <CanvasCard title="Getting Started">
      <DynText
        text={"Say \"Connect Zendesk\" or \"Connect Linear\" — I'll pull tickets, auto-triage, and build SLA tracking."}
        variant="muted"
       />
    </CanvasCard>
  </Column>
)
