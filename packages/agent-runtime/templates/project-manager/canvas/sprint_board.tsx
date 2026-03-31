// Sprint Board

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="📋 Sprint Board" variant="h2" />
      <DynBadge text="Ready to set up" variant="outline" />
    </Row>
    <Grid columns={4}>
      <Metric label="Open Tasks" value={data.metrics.openTasks} />
      <Metric label="Velocity" value={data.metrics.velocity} unit="pts" />
      <Metric label="Open Bugs" value={data.metrics.bugs} />
      <Metric label="Done This Sprint" value={data.metrics.done} />
    </Grid>
    <Grid columns={3} gap="md">
      <CanvasCard title="📋 To Do">
        <DynText text="Tasks will appear here" variant="muted" />
      </CanvasCard>
      <CanvasCard title="🔄 In Progress">
        <DynText text="Active tasks" variant="muted" />
      </CanvasCard>
      <CanvasCard title="✅ Done">
        <DynText text="Completed tasks" variant="muted" />
      </CanvasCard>
    </Grid>
    <CanvasCard title="🚀 Getting Started">
      <DynText
        text={"Say \"Connect Linear\" to import tasks, or \"Create a sprint board\" to start tracking tasks directly here."}
        variant="muted"
       />
    </CanvasCard>
  </Column>
)
