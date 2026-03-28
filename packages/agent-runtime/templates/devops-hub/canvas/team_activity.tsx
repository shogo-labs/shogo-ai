// Team Activity

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="📊 Team Activity" variant="h2" />
      <DynBadge text="Not yet generated" variant="outline" />
    </Row>
    <Grid columns={4}>
      <Metric label="Commits (24h)" value={data.metrics.commits} />
      <Metric label="PRs Merged" value={data.metrics.prsMerged} />
      <Metric label="Reviews" value={data.metrics.reviews} />
      <Metric label="Velocity" value={data.metrics.velocity} />
    </Grid>
    <CanvasCard
      title="Standup Summary"
      description="Auto-generated from git activity"
    >
      <DynText
        text="Once GitHub is connected, standup summaries will be auto-generated here each morning with per-developer Done / In Progress / Blockers."
        variant="muted"
       />
    </CanvasCard>
    <CanvasCard
      title="Activity Feed"
      description="Recent commits, PRs, and reviews"
    >
      <DynText
        text="A chronological feed of engineering activity across your tracked repos."
        variant="muted"
       />
    </CanvasCard>
  </Column>
)
