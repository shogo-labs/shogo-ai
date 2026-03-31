// Research Dashboard

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="Research Dashboard" variant="h2" />
      <DynBadge text="Ready to research" variant="outline" />
    </Row>
    <Grid columns={3}>
      <Metric label="Tracked Topics" value={data.metrics.topics} />
      <Metric label="Sources Indexed" value={data.metrics.sources} />
      <Metric label="Last Updated" value={data.metrics.updated} />
    </Grid>
    <CanvasCard title="Active Research" description="Your research projects">
      <DynText
        text={"Tell me a topic to research and I'll search the web, synthesize findings, and build an analysis dashboard. Try: \"Research the latest developments in AI agents\""}
        variant="muted"
       />
    </CanvasCard>
    <CanvasCard title="Getting Started">
      <DynText
        text="I research from 5+ sources, distinguish facts from opinions, and always cite URLs. Ask anything."
        variant="muted"
       />
    </CanvasCard>
  </Column>
)
