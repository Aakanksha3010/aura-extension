// Edge Function: tryon
// Generates a virtual try-on, enforces the free-tier rate limit, stores the
// result in tryon-results storage, and returns a signed URL.
//
// Two engines, in priority order:
//   1. FASHN v1.6 via fal.ai (if FAL_KEY is set) — a purpose-built virtual
//      try-on model that repaints ONLY the garment region, so the person's
//      face/identity is preserved by construction. Multi-item outfits are
//      chained garment-by-garment.
//   2. Gemini image models (fallback) — general image gen; identity is prompt-
//      guarded but can drift. Used when FAL_KEY is absent or FASHN fails.
//
// Required env vars (Supabase Dashboard → Edge Functions → Secrets):
//   GEMINI_API_KEY            (fallback engine)
//   FAL_KEY                   (primary engine — add this to enable identity-lock)
//   SUPABASE_URL              (auto-set)
//   SUPABASE_ANON_KEY         (auto-set)
//   SUPABASE_SERVICE_ROLE_KEY (auto-set)

import { createClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const ClothingItemSchema = z.object({
  base64: z.string().min(1),
  mimeType: z.string().default('image/jpeg'),
  name: z.string(),
  brand: z.string().optional(),
  category: z.enum(['top', 'bottom', 'dress', 'shoes', 'outerwear', 'accessory']),
})

const TryOnRequestSchema = z.object({
  avatarBase64: z.string().min(1),
  avatarMimeType: z.string().default('image/jpeg'),
  clothingItems: z.array(ClothingItemSchema).min(1).max(5),
})

type ClothingItem = z.infer<typeof ClothingItemSchema>

// ── FASHN (fal.ai) primary engine ─────────────────────────────────────────────

// Map our categories → FASHN's. Garment-VTON only handles worn clothing, so
// shoes/accessories have no mapping and are skipped in the VTON pass.
const FASHN_CATEGORY: Record<string, string | null> = {
  top: 'tops',
  bottom: 'bottoms',
  dress: 'one-pieces',
  outerwear: 'tops',
  shoes: null,
  accessory: null,
}

interface EngineResult {
  ok: boolean
  bytes?: Uint8Array
  mimeType?: string
  model?: string
  skipped?: number   // garments not applied (shoes/accessories)
  reason?: string
}

// Chain each supported garment through FASHN, feeding one result into the next
// so a full outfit builds up while the face stays locked. `model_image` starts
// as the avatar data URI and becomes the previous step's result URL.
async function runFashnTryOn(
  falKey: string,
  avatarDataUri: string,
  clothingItems: ClothingItem[],
): Promise<EngineResult> {
  const garments = clothingItems.filter(i => FASHN_CATEGORY[i.category])
  const skipped = clothingItems.length - garments.length
  if (garments.length === 0) return { ok: false, reason: 'no VTON-supported garments' }

  let modelImage = avatarDataUri
  let lastUrl: string | null = null

  for (const item of garments) {
    const res = await fetch('https://fal.run/fal-ai/fashn/tryon/v1.6', {
      method: 'POST',
      headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_image: modelImage,
        garment_image: `data:${item.mimeType};base64,${item.base64}`,
        category: FASHN_CATEGORY[item.category],
        mode: 'balanced',
        output_format: 'png',
      }),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return { ok: false, reason: `fashn ${res.status}: ${t.slice(0, 200)}` }
    }
    const data = await res.json()
    const url = data?.images?.[0]?.url
    if (!url) return { ok: false, reason: 'fashn returned no image' }
    modelImage = url
    lastUrl = url
  }

  const imgRes = await fetch(lastUrl!)
  if (!imgRes.ok) return { ok: false, reason: `download ${imgRes.status}` }
  const bytes = new Uint8Array(await imgRes.arrayBuffer())
  return { ok: true, bytes, mimeType: 'image/png', model: 'fashn/tryon/v1.6', skipped }
}

// ── Gemini fallback engine ────────────────────────────────────────────────────

const bodyRegion = (cat: string): string => {
  switch (cat) {
    case 'dress': return 'FULL BODY from shoulders to feet — completely replaces both top and bottom, NO separate pants or skirt underneath'
    case 'top': return 'upper body only (torso and arms)'
    case 'bottom': return 'lower body only (waist to feet)'
    case 'outerwear': return 'over the full outfit as an outer layer'
    case 'shoes': return 'feet only'
    default: return 'as an accessory on the appropriate body part'
  }
}

async function runGeminiTryOn(
  geminiKey: string,
  avatarBase64: string,
  avatarMimeType: string,
  clothingItems: ClothingItem[],
): Promise<EngineResult> {
  const descriptions = clothingItems.map(item =>
    `${item.brand ? item.brand + ' ' : ''}${item.name}`.trim()
  )
  const garmentLines = clothingItems.map((item, i) =>
    `- Image ${i + 2}: '${descriptions[i]}' → applies to: ${bodyRegion(item.category)}`
  ).join(String.fromCharCode(10))

  const prompt = `You are an expert photo EDITOR performing a virtual try-on. You are NOT generating a new image — you are EDITING the existing photograph in Image 1 and changing ONLY the clothing.

INPUTS:
- Image 1: a photograph of the person. This exact photo is your canvas. Keep the person and the background as they are.
${garmentLines}

TASK: Return Image 1, edited so the person wears ALL the garment(s) above as one complete outfit. Change ONLY the clothing pixels. Everything else must stay the SAME photograph.

IDENTITY LOCK (highest priority — never violate):
- The face, facial features, expression, skin tone, hair and head must remain PIXEL-IDENTICAL to Image 1. Do NOT redraw, beautify, slim, age, or restyle the person in any way.
- Keep the exact same body shape, proportions, pose and camera framing as Image 1.
- If preserving the face perfectly conflicts with the garment, favor the face — an unchanged face matters more than a perfect garment.

GARMENT FIDELITY:
- Reproduce each garment's exact color, pattern, texture and design from its image.
- Apply each garment ONLY to its specified body region. A DRESS covers the full body — do NOT add a separate pant or skirt underneath.
- Every garment listed must appear, draped naturally with realistic folds and shadows.

OUTPUT: one photorealistic image — the SAME person and pose as Image 1, full body head-to-toe, with only the clothing changed. Do NOT crop the head or feet.`

  const garmentParts = clothingItems.map(item => ({
    inlineData: { mimeType: item.mimeType, data: item.base64 },
  }))

  const models = [
    'gemini-2.5-flash-image',
    'gemini-2.5-flash-preview-image-generation',
    'gemini-2.0-flash-preview-image-generation',
    'gemini-2.0-flash-exp',
  ]

  for (const model of models) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt },
                { inlineData: { mimeType: avatarMimeType, data: avatarBase64 } },
                ...garmentParts,
              ],
            }],
            generationConfig: {
              responseModalities: ['IMAGE', 'TEXT'],
              temperature: 0.25,
              topP: 0.95,
              topK: 40,
            },
          }),
        }
      )
      const data = await res.json()
      if (res.ok) {
        const imgPart = (data.candidates?.[0]?.content?.parts ?? [])
          .find((p: { inlineData?: { data?: string; mimeType?: string } }) => p.inlineData?.data)
        if (imgPart) {
          const bytes = Uint8Array.from(atob(imgPart.inlineData.data), c => c.charCodeAt(0))
          return { ok: true, bytes, mimeType: imgPart.inlineData.mimeType ?? 'image/png', model }
        }
      }
      console.warn(`${model} failed:`, data.error?.message)
    } catch (e) {
      console.warn(`${model} error:`, (e as Error).message)
    }
  }
  return { ok: false, reason: 'all Gemini models failed' }
}

// ── Handler ───────────────────────────────────────────────────────────────────

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

    // Rate limit check
    const { data: profile } = await supabase
      .from('profiles')
      .select('try_on_count, try_on_limit')
      .eq('id', user.id)
      .single()

    if (!profile) return json({ error: 'Profile not found' }, 404)
    if (profile.try_on_count >= profile.try_on_limit) {
      return json({ error: 'Free limit reached. Upgrade to Pro for unlimited try-ons.' }, 429)
    }

    // Validate request body
    const body = await req.json()
    const parsed = TryOnRequestSchema.safeParse(body)
    if (!parsed.success) {
      return json({ error: 'Invalid request', details: parsed.error.issues }, 400)
    }
    const { avatarBase64, avatarMimeType, clothingItems } = parsed.data

    // Engine 1: FASHN (identity-locked) when configured; else fall through.
    let result: EngineResult | null = null
    const falKey = Deno.env.get('FAL_KEY')
    if (falKey) {
      const f = await runFashnTryOn(falKey, `data:${avatarMimeType};base64,${avatarBase64}`, clothingItems)
      if (f.ok) result = f
      else console.warn('FASHN failed, falling back to Gemini:', f.reason)
    }

    // Engine 2: Gemini fallback
    if (!result) {
      const g = await runGeminiTryOn(Deno.env.get('GEMINI_API_KEY')!, avatarBase64, avatarMimeType, clothingItems)
      if (g.ok) result = g
    }

    if (!result?.ok || !result.bytes) {
      await admin.from('usage_logs').insert({
        user_id: user.id, action: 'try_on', model_used: null, success: false,
      })
      return json({ error: 'Try-on generation failed. Please try again.' }, 500)
    }

    // Upload result
    const storagePath = `${user.id}/${Date.now()}.png`
    const { error: uploadError } = await admin.storage
      .from('tryon-results')
      .upload(storagePath, result.bytes, { contentType: result.mimeType ?? 'image/png', upsert: false })

    // Increment try_on_count
    await supabase
      .from('profiles')
      .update({ try_on_count: profile.try_on_count + 1 })
      .eq('id', user.id)

    // Log usage
    await admin.from('usage_logs').insert({
      user_id: user.id, action: 'try_on', model_used: result.model ?? null, success: true,
    })

    // A note the client can surface if some items couldn't be applied.
    const note = result.skipped
      ? `${result.skipped} item(s) (shoes/accessories) can't be applied by the try-on model and were skipped.`
      : undefined

    if (uploadError) {
      console.error('Storage upload failed:', uploadError.message)
      let bin = ''
      for (let i = 0; i < result.bytes.length; i++) bin += String.fromCharCode(result.bytes[i])
      return json({ dataUrl: `data:${result.mimeType};base64,${btoa(bin)}`, engine: result.model, note })
    }

    const { data: signedData } = await admin.storage
      .from('tryon-results')
      .createSignedUrl(storagePath, 60 * 60 * 24 * 7)

    return json({ signedUrl: signedData?.signedUrl, storagePath, engine: result.model, note })

  } catch (error) {
    return json({ error: (error as Error).message }, 500)
  }
})
