// Edge Function: tryon
// Calls Gemini with server-side GEMINI_API_KEY, enforces free-tier rate limit,
// stores result in tryon-results storage, returns a 1-hour signed URL.
//
// Required env vars (set in Supabase Dashboard → Edge Functions → Secrets):
//   GEMINI_API_KEY
//   SUPABASE_URL          (auto-set by Supabase)
//   SUPABASE_ANON_KEY     (auto-set by Supabase)
//   SUPABASE_SERVICE_ROLE_KEY (auto-set by Supabase)

import { createClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'

const CORS = {
  // TODO: restrict to your extension ID once known, e.g.:
  // 'Access-Control-Allow-Origin': 'chrome-extension://YOUR_EXTENSION_ID'
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

    // User client — RLS-scoped to the JWT owner
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    // Admin client — for service-role writes (usage_logs, storage uploads)
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

    // Build prompt
    const descriptions = clothingItems.map(item =>
      `${item.brand ? item.brand + ' ' : ''}${item.name}`.trim()
    )
    const garmentLines = clothingItems.map((item, i) =>
      `- Image ${i + 2}: "${descriptions[i]}" → applies to: ${bodyRegion(item.category)}`
    ).join('\n')

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

    // Try Gemini models in order (best → fallback). gemini-2.5-flash-image
    // ("nano banana") is the GA image-edit model — strongest at identity
    // consistency and typically the fastest, so it goes first.
    const models = [
      'gemini-2.5-flash-image',
      'gemini-2.5-flash-preview-image-generation',
      'gemini-2.0-flash-preview-image-generation',
      'gemini-2.0-flash-exp',
    ]

    const geminiKey = Deno.env.get('GEMINI_API_KEY')!
    let resultBase64: string | null = null
    let resultMimeType = 'image/png'
    let modelUsed: string | null = null

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
                // Low temperature keeps the edit faithful to Image 1 (less
                // creative drift = better identity preservation).
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
            resultBase64 = imgPart.inlineData.data
            resultMimeType = imgPart.inlineData.mimeType ?? 'image/png'
            modelUsed = model
            break
          }
        }
        console.warn(`${model} failed:`, data.error?.message)
      } catch (e) {
        console.warn(`${model} error:`, (e as Error).message)
      }
    }

    if (!resultBase64) {
      await admin.from('usage_logs').insert({
        user_id: user.id,
        action: 'try_on',
        model_used: null,
        success: false,
      })
      return json({ error: 'Try-on generation failed. Please try again.' }, 500)
    }

    // Upload result to tryon-results storage
    const timestamp = Date.now()
    const storagePath = `${user.id}/${timestamp}.png`
    const imageBytes = Uint8Array.from(atob(resultBase64), c => c.charCodeAt(0))

    const { error: uploadError } = await admin.storage
      .from('tryon-results')
      .upload(storagePath, imageBytes, { contentType: resultMimeType, upsert: false })

    // Increment try_on_count
    await supabase
      .from('profiles')
      .update({ try_on_count: profile.try_on_count + 1 })
      .eq('id', user.id)

    // Log usage (service role — no INSERT policy for regular users)
    await admin.from('usage_logs').insert({
      user_id: user.id,
      action: 'try_on',
      model_used: modelUsed,
      success: true,
    })

    if (uploadError) {
      console.error('Storage upload failed:', uploadError.message)
      // Return base64 directly as fallback
      return json({ dataUrl: `data:${resultMimeType};base64,${resultBase64}` })
    }

    // Generate 1-hour signed URL
    const { data: signedData } = await admin.storage
      .from('tryon-results')
      .createSignedUrl(storagePath, 60 * 60 * 24 * 7)

    return json({ signedUrl: signedData?.signedUrl, storagePath })

  } catch (error) {
    return json({ error: (error as Error).message }, 500)
  }
})
