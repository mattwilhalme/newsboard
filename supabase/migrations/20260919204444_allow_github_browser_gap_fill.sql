alter table public.crawler_runs drop constraint crawler_runs_trigger_check;
alter table public.crawler_runs add constraint crawler_runs_trigger_check
  check (trigger in ('supabase_cron','manual_edge_function','github_backup','github_browser_gap_fill'));
