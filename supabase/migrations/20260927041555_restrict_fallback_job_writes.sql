-- Override project default grants; RLS read policy is the only public access.
revoke all on public.crawler_browser_jobs from public,anon,authenticated;
grant select on public.crawler_browser_jobs to anon,authenticated;
