-- Quota integrity.
--
-- THE BUG: policy "own profile" is `for all using (auth.uid() = id)`. RLS is
-- row-level only — it can say WHICH rows a user may update, never WHICH
-- COLUMNS. Combined with the `authenticated` role holding UPDATE on the table
-- (proven by tryon/index.ts having incremented try_on_count through the user's
-- own client), any signed-in user could raise their own ceiling:
--
--   curl -X PATCH "$URL/rest/v1/profiles?id=eq.$UID" \
--        -H "apikey: $ANON_KEY" -H "Authorization: Bearer $USER_JWT" \
--        -H "Content-Type: application/json" \
--        -d '{"try_on_limit": 999999}'
--
-- The anon key ships inside the extension and the JWT is the user's own, so
-- this needs nothing an ordinary user doesn't already have. try_on_count = 0
-- and tier = 'pro' were equally writable. Every paid credit pack could be
-- minted for free.
--
-- THE FIX: column-level privileges, which are a separate layer from RLS and
-- are enforced per column. The row policy still restricts users to their own
-- row; the grant now restricts them to the one column they have any business
-- changing. Quota moves behind security-definer functions callable only by
-- the service role.

revoke update on profiles from anon, authenticated;
grant  update (name) on profiles to authenticated;

-- Atomically reserve one try-on. Returns false if the user is at their limit.
--
-- Replaces a read-then-write in the edge function (SELECT count, compare,
-- UPDATE count+1) where two concurrent requests both read N, both pass the
-- check, and both write N+1 — granting a free generation per race. Here the
-- limit test lives inside the UPDATE, so exactly one of them updates a row.
create or replace function consume_try_on(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  update profiles
     set try_on_count = try_on_count + 1,
         updated_at   = now()
   where id = p_user_id
     and try_on_count < try_on_limit
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

-- Return a reserved credit when generation fails, so a user is never charged
-- for an image they did not receive. Floors at zero: a double refund from a
-- retried error path must not hand out credits.
create or replace function refund_try_on(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update profiles
     set try_on_count = greatest(try_on_count - 1, 0),
         updated_at   = now()
   where id = p_user_id;
end;
$$;

-- EXECUTE on functions is granted to PUBLIC by default, and these are
-- security definer. Without this revoke, refund_try_on would be callable
-- straight from the client — an unlimited free try-on generator, strictly
-- worse than the bug being fixed.
revoke all on function consume_try_on(uuid) from public, anon, authenticated;
revoke all on function refund_try_on(uuid)  from public, anon, authenticated;

-- Avatar generation was exempt from every limit. Each 'generate' call fans out
-- to three Gemini image requests billed to our key, so an authenticated user
-- could loop it and drain the budget with no counter anywhere. Bounded per
-- rolling day; enrollment normally happens once.
create or replace function avatar_generates_today(p_user_id uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::integer
    from usage_logs
   where user_id = p_user_id
     and action = 'avatar_generate'
     and created_at > now() - interval '1 day';
$$;

revoke all on function avatar_generates_today(uuid) from public, anon, authenticated;
