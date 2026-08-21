// Edge Function: tryon
// Generates a virtual try-on, enforces the free-tier rate limit, stores the
// result in tryon-results storage, and returns a signed URL.
//
// Two engines, in priority order:
//   1. Gemini image models (primary) — edits the avatar photo directly and can
//      apply every garment category in one pass, including shoes and
//      accessories. Identity is prompt-guarded, so it can drift.
//   2. FASHN v1.6 via fal.ai (fallback, only if FAL_KEY is set) — a purpose-built
//      VTON model that repaints ONLY the garment region, so identity is
//      preserved by construction. It cannot do shoes or accessories, and it
//      chains one request per garment, so it is slower and partial.
//
// Required env vars (Supabase Dashboard → Edge Functions → Secrets):
//   GEMINI_API_KEY            (primary engine — required)
//   FAL_KEY                   (fallback engine — optional)
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

// ── FASHN (fal.ai) fallback engine ────────────────────────────────────────────

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

// ── Gemini primary engine ─────────────────────────────────────────────────────

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

// ── Prompt variants ───────────────────────────────────────────────────────────
//
// Both variants are kept verbatim so they can be compared on real traffic rather
// than on opinion. `prompt_version` in usage_logs records which one served each
// request; see migration 008.
//
//   v1-editor — treats the avatar as a photograph to retouch, changing only the
//     clothing pixels. Maximum identity safety, but the garment cannot alter the
//     silhouette, so results read as pasted-on.
//   v2-studio — treats the avatar as a studio subject being re-photographed in the
//     outfit. Face is still locked; the body outline is allowed to change where the
//     garment requires it, which is what stops it looking superimposed.

type PromptVariant = 'v1-editor' | 'v2-studio'

const TRYON_PROMPTS: Record<PromptVariant, (garmentLines: string) => string> = {
  'v1-editor': (garmentLines) => `You are an expert photo EDITOR performing a virtual try-on. You are NOT generating a new image — you are EDITING the existing photograph in Image 1 and changing ONLY the clothing.

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

OUTPUT: one photorealistic image — the SAME person and pose as Image 1, full body head-to-toe, with only the clothing changed. Do NOT crop the head or feet.`,

  'v2-studio': (garmentLines) => `You are a fashion photographer producing a studio lookbook shot. Image 1 is a studio reference photograph of your model. Photograph THAT SAME MODEL, in the SAME studio, wearing the outfit below.

INPUTS:
- Image 1: the model. This is a real person and the output must be unmistakably them.
${garmentLines}

TASK: Produce a single photorealistic studio photograph of the model wearing ALL the garment(s) above as one complete outfit, replacing whatever they are currently wearing.

IDENTITY LOCK (highest priority — never violate):
- The face, facial features, expression, skin tone, hair and head must remain IDENTICAL to Image 1. Do NOT redraw, beautify, slim, age, or restyle the person.
- Keep their build, height and proportions, their pose, and the camera angle, distance and framing.
- If preserving the face perfectly conflicts with the garment, favor the face — an unchanged face matters more than a perfect garment.

THE GARMENT IS REAL CLOTHING, NOT AN OVERLAY:
- It has volume and thickness. It may change the model's OUTLINE — a coat is wider than a shirt, a skirt flares away from the leg, a heel changes where the foot meets the floor.
- It hangs under gravity with folds, creases and drape that follow the body underneath.
- It casts contact shadows onto the model and onto the floor, lit by the same studio lighting as Image 1.
- It occludes what is behind it: hems, cuffs and collars sit over the body with correct layering, and edges are sharp where the fabric ends.
- Where the outfit does not cover the body, the model's own skin, arms and legs are visible and correctly lit.

GARMENT FIDELITY:
- Reproduce each garment's exact color, pattern, texture and design from its image.
- Apply each garment ONLY to its specified body region. A DRESS covers the full body — do NOT add a separate pant or skirt underneath.
- Every garment listed must appear.

OUTPUT: one photorealistic studio photograph — the same model, pose and studio backdrop as Image 1, full body head-to-toe, wearing the outfit. Do NOT crop the head or feet.`,
}

// Deterministic per-user assignment: a given user always sees the same variant, so
// their results stay consistent across try-ons and the buckets stay comparable.
// TRYON_PROMPT_VARIANT overrides it outright, which is how you test a variant
// directly without waiting on the split.
function pickPromptVariant(userId: string): PromptVariant {
  const forced = Deno.env.get('TRYON_PROMPT_VARIANT')
  if (forced === 'v1-editor' || forced === 'v2-studio') return forced
  // FNV-1a plus a final avalanche. A plain `h * 31` rolling hash would leave
  // `h % 2` equal to the parity of the character sum — a one-bit hash that splits
  // evenly by luck and would bucket badly for any split other than 50/50.
  let h = 2166136261
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  h ^= h >>> 16
  h = Math.imul(h, 2246822507) >>> 0
  // >>> 0 is load-bearing: ^= yields a SIGNED int32, and a negative h makes
  // h % 100 negative, which is always < 50 — silently dumping every negative
  // hash into one bucket and skewing the split to roughly 75/25.
  h = (h ^ (h >>> 13)) >>> 0
  return h % 100 < 50 ? 'v1-editor' : 'v2-studio'
}

async function runGeminiTryOn(
  geminiKey: string,
  avatarBase64: string,
  avatarMimeType: string,
  clothingItems: ClothingItem[],
  promptVariant: PromptVariant,
): Promise<EngineResult> {
  const descriptions = clothingItems.map(item =>
    `${item.brand ? item.brand + ' ' : ''}${item.name}`.trim()
  )
  const garmentLines = clothingItems.map((item, i) =>
    `- Image ${i + 2}: '${descriptions[i]}' → applies to: ${bodyRegion(item.category)}`
  ).join(String.fromCharCode(10))

  const prompt = TRYON_PROMPTS[promptVariant](garmentLines)

  const garmentParts = clothingItems.map(item => ({
    inlineData: { mimeType: item.mimeType, data: item.base64 },
  }))

  // The 2.5-preview and 2.0 models were shut down by Google in Jan/Feb 2026.
  // Both the GA and -preview spellings of 3.1 Flash Image are listed because
  // availability differs by key; the cascade falls through on a 404 and
  // `model_used` in usage_logs records which one actually served the request.
  const models = [
    'gemini-3.1-flash-image',
    'gemini-3.1-flash-image-preview',
    'gemini-3-pro-image',
    'gemini-2.5-flash-image', // legacy last resort
  ]

  const attempts: string[] = []

  for (const model of models) {
    try {
      // imageConfig only exists on the Gemini 3.x image models. Sending it to the
      // 2.5 legacy model is rejected as an unknown field, which would take out the
      // last-resort fallback as well as the primary.
      const generationConfig: Record<string, unknown> = {
        responseModalities: ['IMAGE', 'TEXT'],
        // Identity preservation is hurt by sampling variance. May be ignored
        // outright by the 3.x image models, which document thinking_level instead.
        temperature: 0.25,
        topP: 0.95,
        topK: 40,
      }
      if (model.startsWith('gemini-3')) {
        // Portrait output — full-body try-on otherwise renders into the default
        // square, which crops heads and feet.
        generationConfig.imageConfig = { aspectRatio: '3:4', imageSize: '2K' }
      }
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          // Key goes in the header, not the query string: a value containing '&'
          // would otherwise be parsed as extra query parameters and produce a
          // baffling "Unknown name" error instead of "API key not valid".
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': geminiKey,
          },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt },
                { inlineData: { mimeType: avatarMimeType, data: avatarBase64 } },
                ...garmentParts,
              ],
            }],
            generationConfig,
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
      // 200 with no image part means the model refused or returned text only —
      // record that distinctly from an API-level error.
      const why = data.error?.message
        ?? (res.ok ? `HTTP ${res.status}: no image in response` : `HTTP ${res.status}`)
      attempts.push(`${model}: ${why}`)
      console.warn(`${model} failed:`, why)
    } catch (e) {
      attempts.push(`${model}: ${(e as Error).message}`)
      console.warn(`${model} error:`, (e as Error).message)
    }
  }
  return { ok: false, reason: attempts.join(' | ') || 'all Gemini models failed' }
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

    // Safety net: ensure this user has a profiles row before the rate-limit
    // lookup below. A missing row (signup trigger absent or failed) would
    // otherwise 404 every try-on. ignoreDuplicates → ON CONFLICT DO NOTHING,
    // so an existing profile's try_on_count is never reset.
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

    // Every engine's failure reason is collected here so a total failure reports
    // what actually went wrong. Previously this referenced an `attemptErrors`
    // that no longer existed in this scope, so the failure path itself threw.
    const attemptErrors: string[] = []
    let result: EngineResult | null = null
    const promptVariant = pickPromptVariant(user.id)

    // Engine 1: Gemini. Trimmed because keys pasted into the dashboard routinely
    // carry a trailing newline, which reads as an invalid key with no useful error.
    const geminiKey = Deno.env.get('GEMINI_API_KEY')?.trim()
    if (!geminiKey) {
      attemptErrors.push('gemini: GEMINI_API_KEY is not set')
    } else {
      const g = await runGeminiTryOn(geminiKey, avatarBase64, avatarMimeType, clothingItems, promptVariant)
      if (g.ok) result = g
      else attemptErrors.push(g.reason ?? 'gemini failed')
    }

    // Engine 2: FASHN, only when configured. It cannot apply shoes or accessories,
    // so a success here may be a partial outfit — `skipped` carries how many items
    // were dropped.
    if (!result) {
      const falKey = Deno.env.get('FAL_KEY')
      if (!falKey) {
        attemptErrors.push('fashn: FAL_KEY is not set')
      } else {
        console.warn('Gemini failed, falling back to FASHN:', attemptErrors.join(' | '))
        const f = await runFashnTryOn(falKey, `data:${avatarMimeType};base64,${avatarBase64}`, clothingItems)
        if (f.ok) result = f
        else attemptErrors.push(f.reason ?? 'fashn failed')
      }
    }

    if (!result?.ok || !result.bytes) {
      await admin.from('usage_logs').insert({
        user_id: user.id, action: 'try_on', model_used: null, success: false,
        prompt_version: promptVariant,
      })
      console.error('All engines failed:', attemptErrors.join(' | '))
      return json({
        error: 'Try-on generation failed. Please try again.',
        detail: attemptErrors.join(' | '),
      }, 500)
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
      prompt_version: result.model?.startsWith('gemini') ? promptVariant : null,
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
