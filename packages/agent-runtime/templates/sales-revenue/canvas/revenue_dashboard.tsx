// Revenue Dashboard

return (
  <Column gap="lg">
    <Row align="center" justify="between">
      <DynText text="💰 Revenue Dashboard" variant="h2" />
      <DynBadge text="Connect Stripe to start" variant="outline" />
    </Row>
    <Grid columns={4}>
      <Metric label="MRR" value={data.metrics.mrr} unit="$" />
      <Metric label="Balance" value={data.metrics.balance} unit="$" />
      <Metric label="Pending" value={data.metrics.pending} />
      <Metric label="Customers" value={data.metrics.customers} />
    </Grid>
    <CanvasCard title="Payment Activity">
      <DynText
        text="Say \"Connect Stripe\" and I'll pull live revenue data with trend charts and failed payment alerts."
        variant="muted"
       />
    </CanvasCard>
  </Column>
)
