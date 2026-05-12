// Edge Function: wardrobe
// GET  /wardrobe        — list all items for the authenticated user (with signed image URLs)
// POST /wardrobe        — save a new item (uploads image to wardrobe-images storage)
// DELETE /wardrobe?id=  — delete item by id (ownership enforced via RLS)

import { createClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
}

const WardrobeItemSchema = z.object({
  name: z.string().min(1).max(200),
  brand: z.string().max(100).optional(),
  price: z.string().max(50).optional(),
  category: z.enum(['top', 'bottom', 'dress', 'shoes', 'outerwear', 'accessory']),
  imageUrl: z.string().url().optional(),
  imageBase64: z.string().optional(),
  imageMimeType: z.string().default('image/jpeg'),
  productUrl: z.string().url().optional().or(z.literal('')),
  source: z.string().max(100).optional(),
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

    const url = new URL(req.url)

    // ── GET: list items ──────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { data: items, error } = await supabase
        .from('wardrobe_items')
        .select('*')
        .eq('user_id', user.id)
        .order('saved_at', { ascending: false })

      if (error) return json({ error: error.message }, 500)

      // Generate fresh signed URLs for items stored in our bucket
      const enriched = await Promise.all(
        items.map(async (item) => {
          if (item.image_storage_path) {
            const { data } = await admin.storage
              .from('wardrobe-images')
              .createSignedUrl(item.image_storage_path, 3600)
            return { ...item, signedImageUrl: data?.signedUrl }
          }
          return item
        })
      )

      return json({ items: enriched })
    }

    // ── POST: save item ──────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = await req.json()
      const parsed = WardrobeItemSchema.safeParse(body)
      if (!parsed.success) {
        return json({ error: 'Invalid request', details: parsed.error.issues }, 400)
      }
      const { name, brand, price, category, imageUrl, imageBase64, imageMimeType, productUrl, source } = parsed.data

      const itemId = crypto.randomUUID()
      let imageStoragePath: string | null = null

      // Upload image to wardrobe-images bucket if base64 is provided
      if (imageBase64) {
        try {
          const ext = imageMimeType.includes('png') ? 'png' : 'jpg'
          const storagePath = `${user.id}/${itemId}.${ext}`
          const imageBytes = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0))
          const { error: uploadError } = await admin.storage
            .from('wardrobe-images')
            .upload(storagePath, imageBytes, { contentType: imageMimeType, upsert: false })
          if (!uploadError) imageStoragePath = storagePath
          else console.warn('Image upload failed:', uploadError.message)
        } catch (e) {
          console.warn('Image upload error:', (e as Error).message)
        }
      }

      const { data: item, error: insertError } = await supabase
        .from('wardrobe_items')
        .insert({
          id: itemId,
          user_id: user.id,
          name,
          brand: brand ?? null,
          price: price ?? null,
          category,
          image_url: imageUrl ?? null,
          image_storage_path: imageStoragePath,
          product_url: productUrl || null,
          source: source ?? null,
        })
        .select()
        .single()

      if (insertError) return json({ error: insertError.message }, 500)

      let signedImageUrl: string | undefined
      if (imageStoragePath) {
        const { data } = await admin.storage
          .from('wardrobe-images')
          .createSignedUrl(imageStoragePath, 3600)
        signedImageUrl = data?.signedUrl
      }

      return json({ item: { ...item, signedImageUrl } }, 201)
    }

    // ── DELETE: remove item ──────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const itemId = url.searchParams.get('id')
      if (!itemId) return json({ error: 'Missing item id' }, 400)

      // Fetch storage path before deletion so we can clean up the bucket
      const { data: item } = await supabase
        .from('wardrobe_items')
        .select('image_storage_path')
        .eq('id', itemId)
        .eq('user_id', user.id)
        .single()

      const { error } = await supabase
        .from('wardrobe_items')
        .delete()
        .eq('id', itemId)
        .eq('user_id', user.id)

      if (error) return json({ error: error.message }, 500)

      if (item?.image_storage_path) {
        await admin.storage.from('wardrobe-images').remove([item.image_storage_path])
      }

      return json({ success: true })
    }

    return json({ error: 'Method not allowed' }, 405)

  } catch (error) {
    return json({ error: (error as Error).message }, 500)
  }
})
