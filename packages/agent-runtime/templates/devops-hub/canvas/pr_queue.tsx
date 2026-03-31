// PR Queue

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="🐙 PR Queue" variant="h2" />
      <DynBadge text="Connect GitHub to start" variant="outline" />
    </Row>
    <Grid columns={4}>
      <Metric label="Open PRs" value={data.metrics.openPrs} />
      <Metric label="Awaiting Review" value={data.metrics.awaitingReview} />
      <Metric label="Stale (>48h)" value={data.metrics.stalePrs} />
      <Metric label="Merged (7d)" value={data.metrics.mergedWeek} />
    </Grid>
    <CanvasCard title="Pull Requests" description="Open PRs sorted by age">
      <DynText
        text="Connect GitHub and I'll populate this with your open PRs, auto-review small changes, and flag stale PRs needing attention."
        variant="muted"
       />
    </CanvasCard>
    <CanvasCard title="🚀 Getting Started">
      <DynText
        text={"Say \"Connect my GitHub\" — I'll fetch your repos, triage PRs, and start auto-reviewing."}
        variant="muted"
       />
    </CanvasCard>
  </Column>
)
