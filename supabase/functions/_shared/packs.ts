// Credit packs — the single source of truth for what a pack costs and grants.
//
// Shared by `billing` (which creates the Payment Link) and `razorpay-webhook`
// (which grants the credits). These two MUST agree: the webhook re-derives
// credits and price from this table rather than trusting the amount echoed
// back in the webhook, so a tampered or replayed payload can't mint credits.
//
// Amounts are in PAISE. Razorpay's `amount` field is always in the currency's
// smallest unit — ₹199 is 19900, not 199. Getting this wrong by 100x is the
// classic Razorpay integration bug, in either direction.

export type Pack = {
  id: string
  credits: number
  amountPaise: number
  currency: 'INR'
  label: string
}

export const PACKS: Record<string, Pack> = {
  pack_50: {
    id: 'pack_50',
    credits: 50,
    amountPaise: 19_900, // ₹199
    currency: 'INR',
    label: '50 try-ons',
  },
}

export const DEFAULT_PACK_ID = 'pack_50'

export function getPack(id: unknown): Pack | null {
  if (typeof id !== 'string') return null
  return PACKS[id] ?? null
}
