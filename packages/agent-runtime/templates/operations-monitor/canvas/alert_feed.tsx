// Alert Feed

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="Alert Feed" variant="h2" />
      <DynBadge text="No alerts yet" variant="outline" />
    </Row>
    <Grid columns={3}>
      <Metric label="Alerts Today" value={data.metrics.alertsToday} />
      <Metric label="Unresolved" value={data.metrics.unresolved} />
      <Metric label="Keywords Watched" value={data.metrics.keywords} />
    </Grid>
    <CanvasCard title="Recent Alerts">
      <DynText
        text="Health check failures, Slack keyword matches, and escalations will be logged here chronologically."
        variant="muted"
       />
    </CanvasCard>
  </Column>
)
