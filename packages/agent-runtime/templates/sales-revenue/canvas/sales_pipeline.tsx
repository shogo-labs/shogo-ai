// Sales Pipeline

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="Sales Pipeline" variant="h2" />
      <DynBadge text="Ready to set up" variant="outline" />
    </Row>
    <Grid columns={4}>
      <Metric label="Pipeline Value" value={data.metrics.value} unit="$" />
      <Metric label="Active Deals" value={data.metrics.deals} />
      <Metric label="Win Rate" value={data.metrics.conversion} />
      <Metric label="Avg Deal Size" value={data.metrics.avgDeal} unit="$" />
    </Grid>
    <Grid columns={5} gap="md">
      <CanvasCard title="New">
        <DynText text="New leads" variant="muted" />
      </CanvasCard>
      <CanvasCard title="Qualified">
        <DynText text="Qualified leads" variant="muted" />
      </CanvasCard>
      <CanvasCard title="Proposal">
        <DynText text="Proposals sent" variant="muted" />
      </CanvasCard>
      <CanvasCard title="Negotiation">
        <DynText text="In negotiation" variant="muted" />
      </CanvasCard>
      <CanvasCard title="Won">
        <DynText text="Closed deals" variant="muted" />
      </CanvasCard>
    </Grid>
    <CanvasCard title="Getting Started">
      <DynText
        text="Tell me about your sales process and I'll set up a pipeline with deal tracking and revenue forecasting."
        variant="muted"
       />
    </CanvasCard>
  </Column>
)
