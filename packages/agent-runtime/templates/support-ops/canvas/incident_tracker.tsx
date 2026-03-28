// Incident Tracker

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="🚨 Incident Tracker" variant="h2" />
      <DynBadge text="No active incidents" variant="outline" />
    </Row>
    <Grid columns={3}>
      <Metric label="Active Incidents" value={data.metrics.active} />
      <Metric label="Avg MTTR" value={data.metrics.mttr} />
      <Metric label="Incidents (30d)" value={data.metrics.total} />
    </Grid>
    <CanvasCard title="Incident History">
      <DynText
        text="Incidents will be logged here with timelines, affected services, and resolution details."
        variant="muted"
       />
    </CanvasCard>
  </Column>
)
