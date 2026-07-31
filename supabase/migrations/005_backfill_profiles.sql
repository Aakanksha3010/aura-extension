-- Backfill profiles for any auth users missing one (e.g. accounts created
-- before the handle_new_user trigger was in place), and re-ensure the trigger
-- so every future signup gets a profile row.

insert into public.profiles (id, email, name)
select u.id,
       coalesce(u.email, u.id::text || '@placeholder.local'),
       u.raw_user_meta_data->>'full_name'
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
on conflict (id) do nothing;

-- Recreate the signup trigger (idempotent, conflict-safe)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
