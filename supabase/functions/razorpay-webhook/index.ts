// Edge Function: razorpay-webhook
// POST /razorpay-webhook — Razorpay payment notifications.
//
// MUST be deployed with --no-verify-jwt. Razorpay cannot present a Supabase
// JWT, so the platform's default JWT gate would reject every delivery with a
// 401 before this code runs. Authentication here is the HMAC signature, which
// is strictly stronger for this purpose: it proves the body came from Razorpay
// AND that it wasn't modified in transit.
//
// Nothing in this file trusts the payload for money or identity beyond the
// user_id in notes. Credits and price are re-derived from PACKS, so a valid
// signature over a tampered amount still grants exactly the pack's credits.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { getPack } from '../_shared/packs.ts'

const encoder = new TextEncoder()

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// Constant-time comparison. A byte-by-byte early return leaks, through response
// timing, how many leading characters of a guessed signature were correct,
// which is enough to forge one given enough attempts.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function verifySignature(rawBody: string, signature: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody))
  return timingSafeEqual(toHex(mac), signature.trim().toLowerCase())
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  try {
    const secret = Deno.env.get('RAZORPAY_WEBHOOK_SECRET')?.trim()
    if (!secret) {
      console.error('RAZORPAY_WEBHOOK_SECRET not set — refusing to process')
      return new Response('Not configured', { status: 503 })
    }

    const signature = req.headers.get('X-Razorpay-Signature')
    if (!signature) return new Response('Missing signature', { status: 400 })

    // The signature covers the RAW bytes. Parsing first and re-serialising
    // would change key order and whitespace and never match.
    const rawBody = await req.text()

    if (!(await verifySignature(rawBody, signature, secret))) {
      console.warn('Webhook signature mismatch — rejected')
      return new Response('Invalid signature', { status: 401 })
    }

    let event: any
    try {
      event = JSON.parse(rawBody)
    } catch {
      return new Response('Invalid JSON', { status: 400 })
    }

    // 200 on events we don't handle. A non-2xx tells Razorpay to retry, and
    // retrying an event we will never act on just fills their queue and our
    // logs for days.
    if (event?.event !== 'payment_link.paid') {
      return new Response(JSON.stringify({ ignored: event?.event ?? 'unknown' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const linkEntity = event?.payload?.payment_link?.entity
    const paymentEntity = event?.payload?.payment?.entity
    const linkId: string | undefined = linkEntity?.id
    const paymentId: string | null = paymentEntity?.id ?? null

    if (!linkId) {
      console.error('payment_link.paid with no entity id')
      return new Response('Malformed payload', { status: 400 })
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Normal path: billing already recorded this link. Self-heal path: the
    // insert in billing failed after Razorpay created the link, so the user
    // paid against a link we have no row for. Reconstruct it from notes rather
    // than silently swallowing a real payment.
    const { data: existing } = await admin
      .from('payments')
      .select('id, user_id, credits, credits_granted_at')
      .eq('razorpay_payment_link_id', linkId)
      .maybeSingle()

    if (!existing) {
      const userId = linkEntity?.notes?.user_id
      const pack = getPack(linkEntity?.notes?.pack_id)

      if (!userId || !pack) {
        console.error('Unknown payment link and notes insufficient to recover', linkId)
        // 200: retrying cannot fix missing notes, and this needs a human.
        return new Response(JSON.stringify({ error: 'unrecoverable', linkId }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      console.warn('Recovering missing payments row from notes', linkId)
      const { error: healError } = await admin.from('payments').insert({
        user_id: userId,
        razorpay_payment_link_id: linkId,
        razorpay_payment_id: paymentId,
        pack_id: pack.id,
        credits: pack.credits,          // from PACKS, never from the payload
        amount_paise: pack.amountPaise, // ditto
        currency: pack.currency,
        status: 'created',
      })
      // A duplicate here means a concurrent delivery won the race and inserted
      // it first. That is fine — grant_pack_credits is the actual guard.
      if (healError && !healError.message.includes('duplicate')) {
        console.error('Recovery insert failed:', healError.message)
        return new Response('Insert failed', { status: 500 })
      }
    }

    // Single statement, guarded by `credits_granted_at is null`, so concurrent
    // or retried deliveries grant exactly once. Returns false if already done.
    const { data: granted, error: rpcError } = await admin.rpc('grant_pack_credits', {
      p_payment_link_id: linkId,
      p_razorpay_payment_id: paymentId,
    })

    if (rpcError) {
      console.error('grant_pack_credits failed:', rpcError.message)
      // 500 → Razorpay retries. This one IS worth retrying: the payment is
      // real and the user has not been credited.
      return new Response('Grant failed', { status: 500 })
    }

    if (granted) {
      const { data: row } = await admin
        .from('payments')
        .select('user_id, credits, pack_id')
        .eq('razorpay_payment_link_id', linkId)
        .maybeSingle()

      if (row) {
        await admin.from('usage_logs').insert({
          user_id: row.user_id,
          action: 'credits_granted',
          model_used: row.pack_id,
          success: true,
        })
      }
      console.log('Credits granted for', linkId)
    } else {
      console.log('Duplicate delivery ignored for', linkId)
    }

    return new Response(JSON.stringify({ ok: true, granted: !!granted }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('razorpay-webhook error:', err)
    return new Response('Internal error', { status: 500 })
  }
})
