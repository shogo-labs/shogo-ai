// Standup Summary

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="Standup Summary" variant="h2" />
      <DynBadge text="Not yet generated" variant="outline" />
    </Row>
    <Grid columns={3}>
      <Metric label="Team Active" value={data.metrics.teamActive} />
      <Metric label="Blockers" value={data.metrics.blockers} />
      <Metric label="Items in Flight" value={data.metrics.inFlight} />
    </Grid>
    <CanvasCard title="Today's Summary">
      <DynText
        text="Standup summaries will be generated here each morning from task activity and team updates."
        variant="muted"
       />
    </CanvasCard>
  </Column>
)
