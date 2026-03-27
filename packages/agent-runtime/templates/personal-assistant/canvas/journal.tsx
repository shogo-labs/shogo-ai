// Journal

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="📓 Journal" variant="h2" />
      <DynBadge text="Start your first entry" variant="outline" />
    </Row>
    <Grid columns={3}>
      <Metric label="Streak" value={data.metrics.streak} unit="days" />
      <Metric label="Entries" value={data.metrics.entries} />
      <Metric label="Avg Mood" value={data.metrics.mood} />
    </Grid>
    <CanvasCard title="Today's Reflection">
      <DynText
        text="Just tell me how your day went — I'll track mood, gratitude, and themes over time."
        variant="muted"
       />
    </CanvasCard>
  </Column>
)
