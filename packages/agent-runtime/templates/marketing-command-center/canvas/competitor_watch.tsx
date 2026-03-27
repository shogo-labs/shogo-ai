// Competitor Watch

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="🔍 Competitor Watch" variant="h2" />
      <DynBadge text="Add competitors to start" variant="outline" />
    </Row>
    <Grid columns={3}>
      <Metric label="Competitors" value={data.metrics.tracked} />
      <Metric label="Changes (7d)" value={data.metrics.changes} />
      <Metric label="Alerts" value={data.metrics.alerts} />
    </Grid>
    <CanvasCard
      title="Comparison Grid"
      description="Features, pricing, and positioning"
    >
      <DynText
        text="Tell me your competitors and I'll build a side-by-side comparison of features, pricing, and messaging that stays current."
        variant="muted"
       />
    </CanvasCard>
    <CanvasCard
      title="Change Log"
      description="Detected changes across competitors"
    >
      <DynText
        text="I'll monitor competitor websites and log pricing, feature, and messaging changes automatically."
        variant="muted"
       />
    </CanvasCard>
  </Column>
)
