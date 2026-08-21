-- 008_prompt_version.sql
-- Records which prompt variant produced each generation, so prompt changes can be
-- compared on real traffic instead of on impressions.
--
-- Nullable on purpose: rows written before this column existed, and rows served by
-- an engine that takes no prompt (FASHN), legitimately have no value.
--
-- Idempotent: safe to re-run.

alter table public.usage_logs
  add column if not exists prompt_version text;

create index if not exists usage_logs_prompt_version_idx
  on public.usage_logs (prompt_version, action, success)
  where prompt_version is not null;

comment on column public.usage_logs.prompt_version is
  'Prompt variant that produced this row (e.g. v1-editor, v2-studio). Null when the
   serving engine takes no prompt, or for rows predating the column.';
