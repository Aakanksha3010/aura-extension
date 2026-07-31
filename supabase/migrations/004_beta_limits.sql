-- Bump try-on limit for beta: new users default to 25, backfill existing accounts
alter table profiles alter column try_on_limit set default 25;

update profiles set try_on_limit = 25 where try_on_limit = 10;
