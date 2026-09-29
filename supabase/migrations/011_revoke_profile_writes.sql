-- Closes the quota bypass. APPLY THIS LAST — after the new edge functions are
-- deployed — and never before.
--
-- Why it is separated from 010:
--
-- The tryon deployed before this work increments try_on_count via the USER's
-- client, and discards the result:
--
--     await supabase.from('profiles').update({ try_on_count: ... }).eq(...)
--                   ^ no `const { error } =`
--
-- The Supabase JS client returns errors, it does not throw them. So once this
-- revoke lands, that call is denied and the denial is silently swallowed.
-- Try-on keeps returning images while the counter stops moving: it fails OPEN,
-- into unlimited free Gemini generations billed to our key, with nothing
-- visible from the client. Running this before the redeploy is therefore worse
-- than not running it at all.
--
-- Once the new tryon (admin.rpc('consume_try_on')) is live, nothing needs
-- user-client UPDATE on profiles and this is safe with zero window.

-- THE BUG THIS FIXES: "own profile" is `for all using (auth.uid() = id)`. RLS
-- is row-level and cannot restrict WHICH COLUMNS are written, and the
-- authenticated role holds UPDATE on every column. Verified against the live
-- database: try_on_limit, try_on_count, tier and email were all writable by
-- the user's own token, and the anon key ships inside the extension.
revoke update on profiles from anon, authenticated;
grant  update (name) on profiles to authenticated;

-- INSERT was the same hole by another door. authenticated retained INSERT on
-- every column, and the "own profile" policy has no WITH CHECK, so its USING
-- clause gates inserts too — a user with no profiles row could POST one
-- carrying try_on_limit: 999999. In practice the on_auth_user_created trigger
-- always creates the row first, so the primary key blocks it; that is a
-- fortunate accident, not a control. Nothing legitimately inserts here from a
-- client: the trigger and the edge functions' service-role upserts both bypass
-- these grants.
revoke insert on profiles from anon, authenticated;
