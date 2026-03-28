// Health Dashboard

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="💓 Health Dashboard" variant="h2" />
      <DynBadge text="No endpoints configured" variant="outline" />
    </Row>
    <Grid columns={4}>
      <Metric label="Endpoints" value={data.metrics.endpoints} />
      <Metric label="Uptime" value={data.metrics.uptime} />
      <Metric label="Avg Latency" value={data.metrics.latency} unit="ms" />
      <Metric label="Incidents (24h)" value={data.metrics.incidents} />
    </Grid>
    <CanvasCard title="Service Status">
      <Column gap="sm">
        <Row align="center" justify="between">
          <DynBadge text="●" variant="secondary" />
          <DynText text="API Server" />
          <DynText text="Not configured" variant="muted" />
        </Row>
        <Row align="center" justify="between">
          <DynBadge text="●" variant="secondary" />
          <DynText text="Database" />
          <DynText text="Not configured" variant="muted" />
        </Row>
        <Row align="center" justify="between">
          <DynBadge text="●" variant="secondary" />
          <DynText text="CDN / Frontend" />
          <DynText text="Not configured" variant="muted" />
        </Row>
      </Column>
    </CanvasCard>
    <CanvasCard title="🚀 Getting Started">
      <DynText
        text="Share your API health check URLs and I'll start monitoring every 5 minutes. Say \"Connect Sentry\" for error tracking."
        variant="muted"
       />
    </CanvasCard>
  </Column>
)
