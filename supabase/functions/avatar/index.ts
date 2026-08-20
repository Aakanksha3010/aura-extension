// Edge Function: avatar
// GET  /avatar — return avatar for authenticated user (with 7-day signed photo URL)
// POST /avatar { action: 'generate', photos[], name?, heightCm?, weightKg? }
//        → generates 3 candidate avatars from the user's photos, stores them under
//          avatars/{userId}/candidates/, returns signed URLs. Does NOT set the avatar.
// POST /avatar { action: 'commit', candidatePath, name?, heightCm?, weightKg? }
//        → promotes the chosen candidate to avatars/{userId}/avatar.jpg, saves the row,
//          and deletes the unchosen candidates.
// POST /avatar { photoBase64, ... } — legacy single-photo direct save (no generation).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

// Same cascade as tryon. gemini-3.1-flash-image accepts up to 4 character-reference
// images, which is what makes multi-photo enrollment worth doing at all.
const IMAGE_MODELS = [
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image',
  'gemini-2.5-flash-image', // legacy last resort
]

const CANDIDATE_COUNT = 3
const MAX_PHOTOS = 4 // model ceiling for character-consistency references

const PhotoSchema = z.object({
  base64: z.string().min(1),
  mimeType: z.string().default('image/jpeg'),
})

const MeasurementFields = {
  name: z.string().min(1).max(100).default('Me'),
  heightCm: z.number().min(50).max(260).optional(),
  weightKg: z.number().min(20).max(400).optional(),
}

const GenerateSchema = z.object({
  action: z.literal('generate'),
  photos: z.array(PhotoSchema).min(1).max(MAX_PHOTOS),
  ...MeasurementFields,
})

const CommitSchema = z.object({
  action: z.literal('commit'),
  candidatePath: z.string().min(1),
  ...MeasurementFields,
})

// Legacy path — a single photo saved directly with no generation step.
const LegacySchema = z.object({
  photoBase64: z.string().min(1),
  photoMimeType: z.string().default('image/jpeg'),
  ...MeasurementFields,
})

/** Soft, qualitative build hint. Deliberately not a numeric instruction — image models
 *  cannot be steered precisely by measurements, and pretending otherwise produces
 *  confident-sounding nonsense. The photos carry the actual body information. */
function buildHint(heightCm?: number, weightKg?: number): string {
  if (!heightCm || !weightKg) return ''
  const bmi = weightKg / ((heightCm / 100) ** 2)
  const build =
    bmi < 18.5 ? 'slim' : bmi < 25 ? 'average' : bmi < 30 ? 'fuller' : 'plus-size'
  return ` The person has a ${build} build and is approximately ${Math.round(heightCm)}cm tall — but the reference photos are authoritative for body shape.`
}

function avatarPrompt(photoCount: number, heightCm?: number, weightKg?: number): string {
  return `Generate a clean, full-body reference photograph of the EXACT person shown in the ${photoCount} reference image${photoCount > 1 ? 's' : ''}.

The reference images are all the SAME person. Preserve their identity precisely: face, facial features, skin tone, hair colour and style, and body proportions.${buildHint(heightCm, weightKg)}

OUTPUT REQUIREMENTS:
1. IDENTITY — this must be unmistakably the same person as the reference images. Do not beautify, slim, lighten, or otherwise alter their face or body.
2. FRAMING — full body, head to feet, entire figure visible, centred, standing upright and facing the camera.
3. BACKGROUND — a plain, evenly lit, neutral light-grey studio backdrop. Nothing else in frame.
4. CLOTHING — simple, plain, well-fitted neutral clothing (a plain fitted top and plain trousers). No patterns, logos, jackets, scarves, shawls, drapes, or bulky layers.
5. LIGHTING — soft, even, neutral studio lighting with no harsh shadows.
6. POSE — relaxed and natural, arms at the sides and clearly separated from the body, hands visible.

PROHIBITIONS:
- Do NOT change the person's identity or substitute a different person.
- Do NOT crop the head or the feet.
- Do NOT include other people, props, text, or watermarks.`
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

    // Safety net: ensure this user has a profiles row before anything that
    // depends on it. avatars.user_id references profiles(id), so a missing row
    // (signup trigger absent or failed) rejects every upsert.
    // ignoreDuplicates → ON CONFLICT DO NOTHING, so existing profiles are never
    // overwritten.
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

    const signed = async (path: string) => {
      const { data } = await admin.storage
        .from('avatars')
        .createSignedUrl(path, 60 * 60 * 24 * 7)
      return data?.signedUrl
    }

    const decode = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0))

    // ── GET: fetch avatar ────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { data: avatar, error } = await supabase
        .from('avatars')
        .select('*')
        .eq('user_id', user.id)
        .single()

      // PGRST116 = no rows — not an error, user just has no avatar yet
      if (error && error.code !== 'PGRST116') return json({ error: error.message }, 500)
      if (!avatar) return json({ avatar: null })

      const signedPhotoUrl = avatar.photo_url ? await signed(avatar.photo_url) : undefined
      return json({ avatar: { ...avatar, signedPhotoUrl } })
    }

    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

    const body = await req.json()

    // ── POST generate: build candidate avatars ───────────────────────────────
    if (body?.action === 'generate') {
      const parsed = GenerateSchema.safeParse(body)
      if (!parsed.success) {
        return json({ error: 'Invalid request', details: parsed.error.issues }, 400)
      }
      const { photos, heightCm, weightKg } = parsed.data

      const geminiKey = Deno.env.get('GEMINI_API_KEY')?.trim()
      if (!geminiKey) return json({ error: 'Image generation is not configured.' }, 500)

      const prompt = avatarPrompt(photos.length, heightCm, weightKg)
      const referenceParts = photos.map(p => ({
        inlineData: { mimeType: p.mimeType, data: p.base64 },
      }))
      const attemptErrors: string[] = []

      /** One candidate. Walks the cascade until a model returns an image. */
      const generateOne = async (): Promise<{ base64: string; mimeType: string } | null> => {
        for (const model of IMAGE_MODELS) {
          try {
            const generationConfig: Record<string, unknown> = {
              responseModalities: ['IMAGE', 'TEXT'],
              // Higher than try-on on purpose: the 3 candidates must differ enough
              // for the choice to be meaningful.
              temperature: 0.85,
              topP: 0.95,
            }
            if (model.startsWith('gemini-3')) {
              // 1K, not 2K — three of these round-trip through the function at once.
              generationConfig.imageConfig = { aspectRatio: '3:4', imageSize: '1K' }
            }

            const res = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
              {
                method: 'POST',
                // Key in the header, not the query string — see tryon/index.ts.
                headers: {
                  'Content-Type': 'application/json',
                  'x-goog-api-key': geminiKey,
                },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: prompt }, ...referenceParts] }],
                  generationConfig,
                }),
              }
            )
            const data = await res.json()
            if (res.ok) {
              const imgPart = (data.candidates?.[0]?.content?.parts ?? [])
                .find((p: { inlineData?: { data?: string; mimeType?: string } }) => p.inlineData?.data)
              if (imgPart) {
                return {
                  base64: imgPart.inlineData.data,
                  mimeType: imgPart.inlineData.mimeType ?? 'image/jpeg',
                }
              }
            }
            const reason = data.error?.message
              ?? (res.ok ? `HTTP ${res.status}: no image in response` : `HTTP ${res.status}`)
            attemptErrors.push(`${model}: ${reason}`)
          } catch (e) {
            attemptErrors.push(`${model}: ${(e as Error).message}`)
          }
        }
        return null
      }

      const results = await Promise.all(
        Array.from({ length: CANDIDATE_COUNT }, () => generateOne())
      )
      const images = results.filter((r): r is { base64: string; mimeType: string } => r !== null)

      if (images.length === 0) {
        await admin.from('usage_logs').insert({
          user_id: user.id, action: 'avatar_generate', success: false,
        })
        console.error('Avatar generation failed:', attemptErrors.join(' | '))
        return json({
          error: 'Avatar generation failed. Please try again.',
          detail: attemptErrors.join(' | '),
        }, 500)
      }

      // Clear any candidates from a previous attempt so they can't accumulate.
      const { data: stale } = await admin.storage
        .from('avatars')
        .list(`${user.id}/candidates`)
      if (stale?.length) {
        await admin.storage
          .from('avatars')
          .remove(stale.map(f => `${user.id}/candidates/${f.name}`))
      }

      const batch = Date.now()
      const candidates: { path: string; url: string | undefined }[] = []
      for (const [i, img] of images.entries()) {
        const ext = img.mimeType.includes('png') ? 'png' : 'jpg'
        const path = `${user.id}/candidates/${batch}-${i}.${ext}`
        const { error: upErr } = await admin.storage
          .from('avatars')
          .upload(path, decode(img.base64), { contentType: img.mimeType, upsert: true })
        if (upErr) {
          console.warn('Candidate upload failed:', upErr.message)
          continue
        }
        candidates.push({ path, url: await signed(path) })
      }

      if (candidates.length === 0) {
        return json({ error: 'Could not store generated avatars.' }, 500)
      }

      await admin.from('usage_logs').insert({
        user_id: user.id,
        action: 'avatar_generate',
        model_used: IMAGE_MODELS[0],
        success: true,
      })

      // Enrollment deliberately does not consume try_on_count — charging a user
      // three credits before their first try-on is a bad first run.
      return json({ candidates })
    }

    // ── POST commit: promote a chosen candidate to the avatar ────────────────
    if (body?.action === 'commit') {
      const parsed = CommitSchema.safeParse(body)
      if (!parsed.success) {
        return json({ error: 'Invalid request', details: parsed.error.issues }, 400)
      }
      const { candidatePath, name, heightCm, weightKg } = parsed.data

      // Never let a caller read or promote another user's object.
      if (!candidatePath.startsWith(`${user.id}/candidates/`)) {
        return json({ error: 'Invalid candidate path' }, 403)
      }

      const { data: blob, error: dlErr } = await admin.storage
        .from('avatars')
        .download(candidatePath)
      if (dlErr || !blob) {
        return json({ error: 'Selected avatar could not be found. Please regenerate.' }, 404)
      }

      const ext = candidatePath.endsWith('.png') ? 'png' : 'jpg'
      const contentType = ext === 'png' ? 'image/png' : 'image/jpeg'
      const storagePath = `${user.id}/avatar.${ext}`
      const bytes = new Uint8Array(await blob.arrayBuffer())

      const { error: uploadError } = await admin.storage
        .from('avatars')
        .upload(storagePath, bytes, { contentType, upsert: true })
      if (uploadError) {
        return json({ error: 'Photo upload failed: ' + uploadError.message }, 500)
      }

      const { data: avatar, error: upsertError } = await supabase
        .from('avatars')
        .upsert(
          {
            user_id: user.id,
            name,
            photo_url: storagePath,
            height_cm: heightCm ?? null,
            weight_kg: weightKg ?? null,
          },
          { onConflict: 'user_id' }
        )
        .select()
        .single()

      if (upsertError) return json({ error: upsertError.message }, 500)

      // Best-effort cleanup — a leftover candidate is harmless, a failed save is not.
      const { data: leftovers } = await admin.storage
        .from('avatars')
        .list(`${user.id}/candidates`)
      if (leftovers?.length) {
        await admin.storage
          .from('avatars')
          .remove(leftovers.map(f => `${user.id}/candidates/${f.name}`))
      }

      await admin.from('usage_logs').insert({
        user_id: user.id, action: 'avatar_save', success: true,
      })

      return json({ avatar: { ...avatar, signedPhotoUrl: await signed(storagePath) } })
    }

    // ── POST legacy: single photo, saved as-is ───────────────────────────────
    const parsed = LegacySchema.safeParse(body)
    if (!parsed.success) {
      return json({ error: 'Invalid request', details: parsed.error.issues }, 400)
    }
    const { name, photoBase64, photoMimeType, heightCm, weightKg } = parsed.data

    const ext = photoMimeType.includes('png') ? 'png' : 'jpg'
    const storagePath = `${user.id}/avatar.${ext}`

    const { error: uploadError } = await admin.storage
      .from('avatars')
      .upload(storagePath, decode(photoBase64), { contentType: photoMimeType, upsert: true })
    if (uploadError) {
      return json({ error: 'Photo upload failed: ' + uploadError.message }, 500)
    }

    const { data: avatar, error: upsertError } = await supabase
      .from('avatars')
      .upsert(
        {
          user_id: user.id,
          name,
          photo_url: storagePath,
          height_cm: heightCm ?? null,
          weight_kg: weightKg ?? null,
        },
        { onConflict: 'user_id' }
      )
      .select()
      .single()

    if (upsertError) return json({ error: upsertError.message }, 500)

    await admin.from('usage_logs').insert({
      user_id: user.id, action: 'avatar_save', success: true,
    })

    return json({ avatar: { ...avatar, signedPhotoUrl: await signed(storagePath) } })

  } catch (error) {
    return json({ error: (error as Error).message }, 500)
  }
})
