import { cartTotals, formatCents, type CartItem } from './src/cart'

const items: CartItem[] = [
  { name: 'Mug', priceCents: 1200, quantity: 2 },
  { name: 'Poster', priceCents: 2500, quantity: 1 },
]

const page = (coupon: string) => {
  const t = cartTotals(items, coupon)
  const rows = items
    .map((i) => `<tr><td>${i.name} x ${i.quantity}</td><td>${formatCents(i.priceCents * i.quantity)}</td></tr>`)
    .join('')
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Checkout</title>
<style>body{font-family:system-ui;max-width:420px;margin:48px auto}td{padding:4px 12px 4px 0}#total{font-weight:700}</style></head>
<body>
<h1>Checkout</h1>
<table>${rows}
<tr><td>Subtotal</td><td id="subtotal">${formatCents(t.subtotalCents)}</td></tr>
<tr><td>Shipping</td><td id="shipping">${formatCents(t.shippingCents)}</td></tr>
<tr><td>Discount</td><td id="discount">-${formatCents(t.discountCents)}</td></tr>
<tr id="total"><td>Total</td><td>${formatCents(t.totalCents)}</td></tr></table>
<form><input name="coupon" placeholder="Coupon code" value="${coupon}"><button>Apply</button></form>
</body></html>`
}

const server = Bun.serve({
  port: Number(process.env.PORT) || 3000,
  fetch(req) {
    const url = new URL(req.url)
    const coupon = (url.searchParams.get('coupon') ?? '').replace(/[^A-Za-z0-9]/g, '')
    if (url.pathname === '/api/total') return Response.json(cartTotals(items, coupon))
    return new Response(page(coupon), { headers: { 'content-type': 'text/html; charset=utf-8' } })
  },
})
console.log(`Checkout on http://localhost:${server.port}`)
