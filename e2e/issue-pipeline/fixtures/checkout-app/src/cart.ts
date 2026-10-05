export interface CartItem {
  name: string
  /** Unit price in cents. */
  priceCents: number
  quantity: number
}

export interface Totals {
  subtotalCents: number
  shippingCents: number
  discountCents: number
  totalCents: number
}

/** Orders under this subtotal pay flat shipping. */
export const FREE_SHIPPING_FROM_CENTS = 5000
export const FLAT_SHIPPING_CENTS = 500

/** Coupon code -> percent off the items (shipping is never discounted). */
export const COUPONS: Record<string, number> = {
  SAVE10: 10,
  SAVE25: 25,
}

export function subtotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0)
}

export function shipping(subtotalCents: number): number {
  if (subtotalCents === 0) return 0
  return subtotalCents >= FREE_SHIPPING_FROM_CENTS ? 0 : FLAT_SHIPPING_CENTS
}

export function cartTotals(items: CartItem[], coupon?: string): Totals {
  const subtotalCents = subtotal(items)
  const shippingCents = shipping(subtotalCents)
  const percent = coupon ? (COUPONS[coupon.trim().toUpperCase()] ?? 0) : 0
  const discountCents = Math.round(((subtotalCents + shippingCents) * percent) / 100)
  return {
    subtotalCents,
    shippingCents,
    discountCents,
    totalCents: subtotalCents + shippingCents - discountCents,
  }
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
