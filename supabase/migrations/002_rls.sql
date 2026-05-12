-- Enable RLS on all tables
alter table profiles         enable row level security;
alter table avatars          enable row level security;
alter table wardrobe_items   enable row level security;
alter table outfits          enable row level security;
alter table outfit_items     enable row level security;
alter table usage_logs       enable row level security;
alter table subscriptions    enable row level security;
alter table affiliate_clicks enable row level security;

-- profiles: users can only read/update their own row
create policy "own profile" on profiles
  for all using (auth.uid() = id);

-- avatars: users can only see/modify their own avatar
create policy "own avatar" on avatars
  for all using (auth.uid() = user_id);

-- wardrobe_items: users can only see/modify their own items
create policy "own wardrobe" on wardrobe_items
  for all using (auth.uid() = user_id);

-- outfits: users can only see/modify their own outfits
create policy "own outfits" on outfits
  for all using (auth.uid() = user_id);

-- outfit_items: accessible if the outfit belongs to the user
create policy "own outfit items" on outfit_items
  for all using (
    exists (
      select 1 from outfits
      where outfits.id = outfit_items.outfit_id
      and outfits.user_id = auth.uid()
    )
  );

-- usage_logs: users can only read their own logs (insert via service role only)
create policy "own usage logs read" on usage_logs
  for select using (auth.uid() = user_id);

-- subscriptions: users can only read their own subscription
create policy "own subscription read" on subscriptions
  for select using (auth.uid() = user_id);

-- affiliate_clicks: users can insert their own clicks, read their own
create policy "own affiliate clicks" on affiliate_clicks
  for all using (auth.uid() = user_id);
