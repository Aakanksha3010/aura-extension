// Edge Function: billing
// GET  /billing            — list this user's packs + current quota
// POST /billing {packId}   — create a Razorpay Payment Link, return its short_url
//
// Why Payment Links and not Razorpay Checkout: Chrome Manifest V3 forbids
// remote hosted scripts, and this extension declares no content_security_policy
// so the default `script-src 'self'` applies. checkout.razorpay.com/v1/checkout.js
// cannot load inside popup.html at all. A Payment Link is a Razorpay-hosted page
// we open in a normal tab, so no third-party script ever enters the extension.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import { getPack, PACKS, DEFAULT_PACK_ID } from '../_shared/packs.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const RAZORPAY_API = 'https://api.razorpay.com/v1/payment_links'

// A checkout should be prompt. A long window mostly produces stale links a user
// pays against after changing their mind. Razorpay requires >= 15 minutes.
const LINK_TTL_SECONDS = 60 * 60

const CreateSchema = z.object({
  packId: z.string().max(40).optional(),
})

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return json({ error: 'Unauthorized' }, 401)

    // Same safety net the other functions use — payments.user_id references
    // profiles(id), so a missing profile row would reject every insert.
    const { error: profileError } = await admin
      .from('profiles')
      .upsert(
        {
          id: user.id,
          email: user.email ?? `${user.id}@placeholder.local`,
          name: user.user_metadata?.full_name ?? null,
        },
        { onConflict: 'id', ignoreDuplicates: true }
      )
    if (profileError) console.warn('Profile ensure failed:', profileError.message)

    // ── GET: quota + purchase history ────────────────────────────────────────
    if (req.method === 'GET') {
      const { data: profile } = await supabase
        .from('profiles')
        .select('try_on_count, try_on_limit')
        .eq('id', user.id)
        .single()

      const { data: payments } = await supabase
        .from('payments')
        .select('pack_id, credits, amount_paise, currency, status, created_at, paid_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20)

      return json({
        quota: profile ?? null,
        packs: Object.values(PACKS),
        payments: payments ?? [],
      })
    }

    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

    // ── POST: create a Payment Link ──────────────────────────────────────────
    const keyId = Deno.env.get('RAZORPAY_KEY_ID')?.trim()
    const keySecret = Deno.env.get('RAZORPAY_KEY_SECRET')?.trim()
    if (!keyId || !keySecret) {
      console.error('Razorpay credentials missing')
      return json({ error: 'Payments are not configured yet.' }, 503)
    }

    const body = await req.json().catch(() => ({}))
    const parsed = CreateSchema.safeParse(body)
    if (!parsed.success) {
      return json({ error: 'Invalid request', details: parsed.error.issues }, 400)
    }

    // The client names a pack; it never names a price. Taking an amount from
    // the client would let anyone buy 50 credits for ₹1.
    const pack = getPack(parsed.data.packId ?? DEFAULT_PACK_ID)
    if (!pack) return json({ error: 'Unknown pack' }, 400)

    // reference_id must be unique and <= 40 chars. A uuid is 36.
    const referenceId = crypto.randomUUID()

    const rzpRes = await fetch(RAZORPAY_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`,
      },
      body: JSON.stringify({
        amount: pack.amountPaise,
        currency: pack.currency,
        description: `Aura — ${pack.label}`,
        reference_id: referenceId,
        customer: {
          name: user.user_metadata?.full_name ?? undefined,
          email: user.email ?? undefined,
        },
        // We surface status in the extension; Razorpay does not need to email
        // or SMS the user, and in test mode that mail goes nowhere useful.
        notify: { email: false, sms: false },
        reminder_enable: false,
        // notes come back on the webhook. user_id is the only thing here the
        // webhook actually trusts for identity; credits and price are
        // re-derived from PACKS, never read from this payload.
        notes: {
          user_id: user.id,
          pack_id: pack.id,
        },
        expire_by: Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS,
      }),
    })

    const rzpText = await rzpRes.text()
    if (!rzpRes.ok) {
      // Razorpay's error body can contain account-level detail. Log it, don't
      // return it — the client gets a generic message.
      console.error('Razorpay payment_links failed', rzpRes.status, rzpText)
      return json({ error: 'Could not start checkout. Please try again.' }, 502)
    }

    let link: { id?: string; short_url?: string }
    try {
      link = JSON.parse(rzpText)
    } catch {
      console.error('Razorpay returned non-JSON', rzpText.slice(0, 500))
      return json({ error: 'Could not start checkout. Please try again.' }, 502)
    }

    if (!link.id || !link.short_url) {
      console.error('Razorpay response missing id/short_url', rzpText.slice(0, 500))
      return json({ error: 'Could not start checkout. Please try again.' }, 502)
    }

    // Recorded before the user can pay, so the webhook normally finds a row.
    // If this insert fails the webhook still self-heals from notes — see
    // razorpay-webhook/index.ts — so a failure here is logged, not fatal.
    const { error: insertError } = await admin.from('payments').insert({
      user_id: user.id,
      razorpay_payment_link_id: link.id,
      pack_id: pack.id,
      credits: pack.credits,
      amount_paise: pack.amountPaise,
      currency: pack.currency,
      status: 'created',
    })
    if (insertError) console.error('payments insert failed:', insertError.message)

    return json({
      checkoutUrl: link.short_url,
      paymentLinkId: link.id,
      pack: { id: pack.id, credits: pack.credits, amountPaise: pack.amountPaise, label: pack.label },
    })
  } catch (err) {
    console.error('billing error:', err)
    return json({ error: 'Internal error' }, 500)
  }
})
