// Topic Tracker

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="Topic Tracker" variant="h2" />
      <DynBadge text="No topics tracked yet" variant="outline" />
    </Row>
    <Grid columns={3}>
      <Metric label="Topics Tracked" value={data.metrics.tracked} />
      <Metric label="New Today" value={data.metrics.newToday} />
      <Metric label="Alerts" value={data.metrics.alerts} />
    </Grid>
    <CanvasCard title="Monitored Topics">
      <DynText
        text={"Say \"Track AI agents\" or \"Monitor quantum computing news\" — I'll check for developments on every heartbeat and alert you."}
        variant="muted"
       />
    </CanvasCard>
  </Column>
)
