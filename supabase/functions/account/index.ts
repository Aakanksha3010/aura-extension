// Edge Function: account
// GET    /account  — what we hold on this user (the "export my data" answer)
// DELETE /account  — erase the account and everything attached to it
//
// A privacy policy that promises deletion without this is a false statement,
// and Chrome Web Store policy expects a working path. Deletion here is real
// and irreversible: storage objects first, then the auth user, whose cascade
// takes the database rows with it.

import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
}

const BUCKETS = ['avatars', 'wardrobe-images', 'tryon-results']

// Storage has no cascade. Objects live under a {user_id}/ prefix, and orphaned
// images of someone's face are exactly what "delete my data" must not leave
// behind, so every bucket is walked explicitly.
async function purgeBucket(admin: any, bucket: string, userId: string): Promise<number> {
  let removed = 0
  // Subfolders exist (avatars/{uid}/candidates/), and list() is not recursive.
  for (const prefix of [userId, `${userId}/candidates`]) {
    const { data: files, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000 })
    if (error || !files?.length) continue
    const paths = files.filter((f: any) => f.id !== null).map((f: any) => `${prefix}/${f.name}`)
    if (!paths.length) continue
    const { error: rmError } = await admin.storage.from(bucket).remove(paths)
    if (rmError) throw new Error(`${bucket}: ${rmError.message}`)
    removed += paths.length
  }
  return removed
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

    // Identity comes from the verified token, never from the request body.
    // A user id in the body would let anyone delete anyone.
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return json({ error: 'Unauthorized' }, 401)

    // ── GET: what we hold ────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const [profile, avatar, wardrobe, looks, logs, payments] = await Promise.all([
        supabase.from('profiles').select('email, name, tier, try_on_count, try_on_limit, created_at').eq('id', user.id).maybeSingle(),
        supabase.from('avatars').select('name, created_at').eq('user_id', user.id).maybeSingle(),
        supabase.from('wardrobe_items').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
        supabase.from('outfits').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
        supabase.from('usage_logs').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
        supabase.from('payments').select('pack_id, credits, amount_paise, currency, status, created_at').eq('user_id', user.id),
      ])

      return json({
        account: profile.data ?? null,
        avatar: avatar.data ?? null,
        counts: {
          wardrobeItems: wardrobe.count ?? 0,
          savedLooks: looks.count ?? 0,
          activityRecords: logs.count ?? 0,
        },
        payments: payments.data ?? [],
      })
    }

    if (req.method !== 'DELETE') return json({ error: 'Method not allowed' }, 405)

    // ── DELETE: erase everything ─────────────────────────────────────────────
    //
    // Storage BEFORE the auth user. Deleting the user first cascades the
    // database rows away, and with them every record of which objects belonged
    // to this person — leaving their photos in the bucket with nothing left
    // pointing at them. Unrecoverable in the worst way: the data survives and
    // the means to find it does not.
    let filesRemoved = 0
    for (const bucket of BUCKETS) {
      filesRemoved += await purgeBucket(admin, bucket, user.id)
    }

    // profiles.id references auth.users on delete cascade, and avatars,
    // wardrobe_items, outfits, usage_logs, subscriptions and payments all
    // reference profiles(id) on delete cascade — so this one call takes the
    // whole graph. affiliate_clicks is on delete set null and is retained
    // without a user id, which is the anonymised aggregate the policy allows.
    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id)
    if (deleteError) {
      console.error('Account deletion failed after purging storage:', deleteError.message)
      // The user's images are already gone; say so rather than implying
      // nothing happened, so a retry is understood as finishing the job.
      return json({
        error: 'Your files were deleted but the account record could not be removed. Contact support and we will finish it.',
        filesRemoved,
      }, 500)
    }

    console.log(`Account ${user.id} deleted; ${filesRemoved} files removed`)
    return json({ deleted: true, filesRemoved })
  } catch (err) {
    console.error('account error:', err)
    return json({ error: 'Internal error' }, 500)
  }
})
