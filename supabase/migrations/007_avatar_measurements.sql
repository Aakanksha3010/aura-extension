-- 007_avatar_measurements.sql
-- Adds optional body measurements to the avatar record.
--
-- These are NOT used to numerically condition the image model — image models cannot be
-- precisely steered by "165cm / 60kg". They serve two purposes:
--   1. soft context in the avatar generation prompt (build description only), and
--   2. the foundation for size recommendation, which is the actual long-term payoff.
-- The uploaded photos remain what determines body shape in the generated avatar.
--
-- Idempotent: safe to re-run.

alter table public.avatars
  add column if not exists height_cm numeric(5,1),
  add column if not exists weight_kg numeric(5,1);

-- Sanity bounds. Wide on purpose — these are self-reported and optional.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'avatars_height_cm_range'
  ) then
    alter table public.avatars
      add constraint avatars_height_cm_range
      check (height_cm is null or (height_cm >= 50 and height_cm <= 260));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'avatars_weight_kg_range'
  ) then
    alter table public.avatars
      add constraint avatars_weight_kg_range
      check (weight_kg is null or (weight_kg >= 20 and weight_kg <= 400));
  end if;
end $$;

comment on column public.avatars.height_cm is
  'Self-reported height in cm. Optional. Soft prompt context + future size recommendation.';
comment on column public.avatars.weight_kg is
  'Self-reported weight in kg. Optional. Soft prompt context + future size recommendation.';
