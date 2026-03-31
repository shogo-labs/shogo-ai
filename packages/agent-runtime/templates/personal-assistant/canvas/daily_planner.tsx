// Daily Planner

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="Daily Planner" variant="h2" />
      <DynBadge text="Ready to set up" variant="outline" />
    </Row>
    <Grid columns={4}>
      <Metric label="Meetings Today" value={data.metrics.meetings} />
      <Metric label="Open Tasks" value={data.metrics.tasks} />
      <Metric label="Reminders" value={data.metrics.reminders} />
      <Metric label="Habit Streak" value={data.metrics.streak} unit="days" />
    </Grid>
    <CanvasCard title="Today's Schedule">
      <DynText
        text={"Connect your calendar and I'll show today's meetings with prep notes. Say \"Connect Google Calendar\" to start."}
        variant="muted"
       />
    </CanvasCard>
    <CanvasCard title="Getting Started">
      <Column gap="md">
        <DynText text="Set up your personal hub:" variant="muted" />
        <Column gap="sm">
          <DynText text={"• \"Connect my Google Calendar\" for daily schedule"} />
          <DynText
            text={"• \"Track exercise and reading habits\" for habit tracking"}
           />
          <DynText text={"• \"Remind me to...\" for reminders and tasks"} />
        </Column>
      </Column>
    </CanvasCard>
  </Column>
)
