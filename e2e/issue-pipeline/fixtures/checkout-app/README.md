# checkout-app fixture

A tiny checkout page with one planted bug (see `BUG.md`): a percentage coupon
also discounts shipping. Used by the eng-pod demo seed
(`scripts/demo/seed-eng-pod.ts`) and `e2e/issue-pipeline/l1-eng-pod-metrics`.

```bash
bun test          # passes on main: nothing covers coupon + shipping together
bun run start     # http://localhost:3000/?coupon=SAVE10 shows $48.60, want $49.10
```

Point the harness at it with `FIXTURE_DIR=e2e/issue-pipeline/fixtures/checkout-app`.
