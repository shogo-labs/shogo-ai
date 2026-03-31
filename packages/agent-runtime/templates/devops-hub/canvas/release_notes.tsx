// Release Notes

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="Release Notes" variant="h2" />
      <DynBadge text="No repos connected" variant="outline" />
    </Row>
    <Grid columns={3}>
      <Metric label="Unreleased PRs" value={data.metrics.unreleased} />
      <Metric label="Days Since Release" value={data.metrics.daysSince} />
      <Metric label="Deploy Status" value={data.metrics.deployStatus} />
    </Grid>
    <CanvasCard
      title="Unreleased Changes"
      description="PRs merged since last release"
    >
      <DynText
        text="I'll automatically track merged PRs and generate changelogs grouped by Features, Fixes, and Breaking Changes."
        variant="muted"
       />
    </CanvasCard>
    <CanvasCard title="Deployment Checklist" description="Pre-release steps">
      <Column gap="sm">
        <Row align="center" gap="sm">
          <DynBadge text="1" variant="secondary" />
          <DynText text="Review changelog and breaking changes" />
        </Row>
        <Row align="center" gap="sm">
          <DynBadge text="2" variant="secondary" />
          <DynText text="Verify CI pipeline is green" />
        </Row>
        <Row align="center" gap="sm">
          <DynBadge text="3" variant="secondary" />
          <DynText text="Tag release and notify stakeholders" />
        </Row>
      </Column>
    </CanvasCard>
  </Column>
)
