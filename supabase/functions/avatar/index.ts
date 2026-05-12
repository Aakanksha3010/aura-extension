// Edge Function: avatar
// GET  /avatar — return avatar for authenticated user (with 1-hour signed photo URL)
// POST /avatar — save/update avatar (uploads photo to avatars/{userId}/avatar.{ext})

import { createClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const AvatarSchema = z.object({
  name: z.string().min(1).max(100).default('Me'),
  photoBase64: z.string().min(1),
  photoMimeType: z.string().default('image/jpeg'),
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

      let signedPhotoUrl: string | undefined
      if (avatar.photo_url) {
        const { data } = await admin.storage
          .from('avatars')
          .createSignedUrl(avatar.photo_url, 3600)
        signedPhotoUrl = data?.signedUrl
      }

      return json({ avatar: { ...avatar, signedPhotoUrl } })
    }

    // ── POST: save/update avatar ─────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = await req.json()
      const parsed = AvatarSchema.safeParse(body)
      if (!parsed.success) {
        return json({ error: 'Invalid request', details: parsed.error.issues }, 400)
      }
      const { name, photoBase64, photoMimeType } = parsed.data

      // Upload photo — always overwrites (upsert) at the same path
      const ext = photoMimeType.includes('png') ? 'png' : 'jpg'
      const storagePath = `${user.id}/avatar.${ext}`
      const photoBytes = Uint8Array.from(atob(photoBase64), c => c.charCodeAt(0))

      const { error: uploadError } = await admin.storage
        .from('avatars')
        .upload(storagePath, photoBytes, { contentType: photoMimeType, upsert: true })

      if (uploadError) {
        return json({ error: 'Photo upload failed: ' + uploadError.message }, 500)
      }

      // Upsert avatar row (user_id is unique, so this replaces on conflict)
      const { data: avatar, error: upsertError } = await supabase
        .from('avatars')
        .upsert(
          { user_id: user.id, name, photo_url: storagePath },
          { onConflict: 'user_id' }
        )
        .select()
        .single()

      if (upsertError) return json({ error: upsertError.message }, 500)

      // Log usage
      await admin.from('usage_logs').insert({
        user_id: user.id,
        action: 'avatar_save',
        success: true,
      })

      const { data: signedData } = await admin.storage
        .from('avatars')
        .createSignedUrl(storagePath, 3600)

      return json({ avatar: { ...avatar, signedPhotoUrl: signedData?.signedUrl } })
    }

    return json({ error: 'Method not allowed' }, 405)

  } catch (error) {
    return json({ error: (error as Error).message }, 500)
  }
})
