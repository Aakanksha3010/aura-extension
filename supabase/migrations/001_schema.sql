-- profiles (1-1 with auth.users, auto-created on signup via trigger)
create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text unique not null,
  name          text,
  tier          text default 'free' check (tier in ('free','pro','byor')),
  try_on_count  integer default 0,
  try_on_limit  integer default 10,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- avatars (1-1 with profiles)
create table avatars (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid unique references profiles(id) on delete cascade,
  name        text,
  photo_url   text,   -- supabase storage path
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- wardrobe_items (1-many with profiles)
create table wardrobe_items (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references profiles(id) on delete cascade,
  name               text not null,
  brand              text,
  price              text,
  category           text check (category in ('top','bottom','dress','shoes','outerwear','accessory')),
  image_url          text,   -- original brand CDN URL
  image_storage_path text,   -- supabase storage path (our CORS-safe copy)
  product_url        text,
  source             text,   -- root domain e.g. zara.com
  saved_at           timestamptz default now()
);

-- outfits (1-many with profiles)
create table outfits (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references profiles(id) on delete cascade,
  result_storage_path text,   -- supabase storage path for try-on result image
  created_at          timestamptz default now()
);

-- outfit_items junction (many-many: outfits <-> wardrobe_items)
create table outfit_items (
  outfit_id         uuid references outfits(id) on delete cascade,
  wardrobe_item_id  uuid references wardrobe_items(id) on delete cascade,
  primary key (outfit_id, wardrobe_item_id)
);

-- usage_logs (1-many with profiles)
create table usage_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references profiles(id) on delete cascade,
  action      text not null,  -- 'try_on' | 'scan' | 'avatar_save'
  model_used  text,
  cost_usd    numeric(10,6),
  success     boolean,
  created_at  timestamptz default now()
);

-- subscriptions (1-1 with profiles)
create table subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid unique references profiles(id) on delete cascade,
  stripe_customer_id      text unique,
  stripe_subscription_id  text unique,
  status                  text default 'inactive'
                          check (status in ('active','inactive','cancelled','past_due')),
  plan                    text default 'free' check (plan in ('free','pro')),
  current_period_end      timestamptz,
  created_at              timestamptz default now(),
  updated_at              timestamptz default now()
);

-- affiliate_clicks (1-many with wardrobe_items)
create table affiliate_clicks (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references profiles(id) on delete set null,
  wardrobe_item_id  uuid references wardrobe_items(id) on delete set null,
  product_url       text,
  source_domain     text,
  clicked_at        timestamptz default now()
);

-- Indexes for common queries
create index on wardrobe_items (user_id, category);
create index on wardrobe_items (user_id, saved_at desc);
create index on outfits (user_id, created_at desc);
create index on usage_logs (user_id, created_at desc);
create index on affiliate_clicks (wardrobe_item_id);

-- Auto-create profile on user signup
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, email, name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();
