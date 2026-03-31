// Hiring Pipeline

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="Hiring Pipeline" variant="h2" />
      <DynBadge text="Ready to set up" variant="outline" />
    </Row>
    <Grid columns={4}>
      <Metric label="Active Candidates" value={data.metrics.candidates} />
      <Metric label="Open Roles" value={data.metrics.roles} />
      <Metric
        label="Avg Time-to-Hire"
        value={data.metrics.timeToHire}
        unit="days"
       />
      <Metric label="Offer Rate" value={data.metrics.offerRate} />
    </Grid>
    <Grid columns={5} gap="md">
      <CanvasCard title="Applied">
        <DynText text="New applicants" variant="muted" />
      </CanvasCard>
      <CanvasCard title="Screen">
        <DynText text="Phone screen" variant="muted" />
      </CanvasCard>
      <CanvasCard title="Interview">
        <DynText text="Interviewing" variant="muted" />
      </CanvasCard>
      <CanvasCard title="Offer">
        <DynText text="Offer sent" variant="muted" />
      </CanvasCard>
      <CanvasCard title="Hired">
        <DynText text="Welcome!" variant="muted" />
      </CanvasCard>
    </Grid>
    <CanvasCard title="Getting Started">
      <DynText
        text="Tell me your open roles and I'll set up candidate tracking, interview scheduling, and hiring metrics."
        variant="muted"
       />
    </CanvasCard>
  </Column>
)
