-- Backfill profiles for any auth users missing one (e.g. accounts created
-- before the handle_new_user trigger was in place), and re-ensure the trigger
-- so every future signup gets a profile row.
--
-- Safe to run repeatedly: the backfill is conflict-proof, the function is
-- CREATE OR REPLACE, and the trigger is dropped-if-exists before creation.
-- Must be run as the `postgres` role (supabase db push / SQL editor), since
-- creating a trigger on auth.users requires ownership of that table.

insert into public.profiles (id, email, name)
select u.id,
       coalesce(u.email, u.id::text || '@placeholder.local'),
       u.raw_user_meta_data->>'full_name'
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
-- No conflict target: profiles has unique constraints on BOTH id and email.
-- `on conflict (id)` would still raise on a duplicate email (two auth users can
-- share an email across providers), which would abort the whole backfill.
on conflict do nothing;

-- Recreate the signup trigger (idempotent, conflict-safe)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
-- Pin the search_path: a security-definer function must not resolve objects
-- through the caller's search_path.
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    coalesce(new.email, new.id::text || '@placeholder.local'), -- email is NOT NULL
    new.raw_user_meta_data->>'full_name'
  )
  on conflict do nothing;
  return new;
exception
  -- Never let profile creation abort the signup itself. If this fires, the
  -- defensive upsert in the wardrobe/avatar/tryon edge functions still creates
  -- the row on the user's first authenticated request.
  when others then
    raise warning 'handle_new_user failed for %: %', new.id, sqlerrm;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
