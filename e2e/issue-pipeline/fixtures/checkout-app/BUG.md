# Coupon takes money off shipping too

On the checkout page the cart is two mugs ($12.00 each) and a poster ($25.00).
That is a $49.00 subtotal, so shipping is $5.00 and the total is $54.00.

Apply the coupon `SAVE10` (10% off the items) and the total should be
`$49.00 - $4.90 + $5.00 = $49.10`. It shows `$48.60`, because the discount is
taken off the shipping as well (10% of $54.00 = $5.40 instead of $4.90).

Shipping is never supposed to be discounted. Repro:

```bash
bun -e "import { cartTotals } from './src/cart'; console.log(cartTotals([{ name: 'Mug', priceCents: 1200, quantity: 2 }, { name: 'Poster', priceCents: 2500, quantity: 1 }], 'SAVE10'))"
```

Or open `http://localhost:3000/?coupon=SAVE10` after `bun run start`.
