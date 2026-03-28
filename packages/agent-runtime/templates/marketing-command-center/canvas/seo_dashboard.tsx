// SEO Dashboard

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="🔍 SEO Dashboard" variant="h2" />
      <DynBadge text="Share your site URL to start" variant="outline" />
    </Row>
    <Grid columns={4}>
      <Metric label="Pages Audited" value={data.metrics.pages} />
      <Metric label="Keywords Tracked" value={data.metrics.keywords} />
      <Metric label="SEO Score" value={data.metrics.score} />
      <Metric label="Issues Found" value={data.metrics.issues} />
    </Grid>
    <CanvasCard
      title="SEO Audit"
      description="Technical and on-page audit results"
    >
      <DynText
        text="Share your website URL and I'll run a comprehensive SEO audit covering technical issues, on-page optimization, schema markup, and AI-search readiness."
        variant="muted"
       />
    </CanvasCard>
    <CanvasCard title="🚀 Getting Started">
      <DynText
        text="Try: \"Audit the SEO on https://example.com\" — I'll analyze technical health, content optimization, and competitive keywords."
        variant="muted"
       />
    </CanvasCard>
  </Column>
)
