// Content Hub

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="✍️ Content Hub" variant="h2" />
      <DynBadge text="Ready to create" variant="outline" />
    </Row>
    <Grid columns={3}>
      <Metric label="Drafts" value={data.metrics.drafts} />
      <Metric label="Published" value={data.metrics.published} />
      <Metric label="Scheduled" value={data.metrics.scheduled} />
    </Grid>
    <CanvasCard
      title="Content Calendar"
      description="Upcoming posts and emails"
    >
      <DynText
        text="Your content calendar will track blog posts, social content, email campaigns, and newsletter editions all in one place."
        variant="muted"
       />
    </CanvasCard>
    <CanvasCard
      title="Recent Drafts"
      description="Copy, emails, and social posts"
    >
      <DynText
        text="Ask me to write anything: \"Draft a homepage headline\" or \"Write a 5-email welcome sequence\" — drafts appear here for review."
        variant="muted"
       />
    </CanvasCard>
  </Column>
)
