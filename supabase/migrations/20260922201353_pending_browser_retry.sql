-- A new general attempt opens a new pending browser retry after a prior failure.
-- Derive one combined outcome from persisted routing, browser runs and results.
-- Edge rows for browser-configured sources are delegation notices, not attempts.
create or replace view public.v_crawler_attempt_status with (security_invoker=true) as
select p.source_id,
 case
  when active.id is not null and a.run_id is distinct from active.id
       and active.started_at > coalesce(a.completed_at,'-infinity'::timestamptz)
       and (active.status='running' or q.queued_at is null or active.started_at>q.queued_at) then
   case when active.status='running' and active.started_at > now()-interval '10 minutes' then 'running' else 'failed' end
  when p.method='browser' and q.queued_at is not null
       and (a.success = false or a.completed_at is null or a.completed_at < now()-interval '420 seconds') then
   case when q.queued_at > now()-interval '20 minutes' then 'pending' else 'failed' end
  when a.success = false then 'failed'
  when a.success then 'success'
  else 'pending'
 end as crawl_status,
 a.completed_at as completed_at,
 a.error as error
from public.crawler_publishers p
left join lateral (
 select sr.* from public.crawler_source_runs sr join public.crawler_runs r on r.id=sr.run_id
 where sr.source_id=p.source_id
 and (p.method<>'browser' or r.trigger in ('github_backup','github_browser_gap_fill'))
 order by sr.completed_at desc limit 1
) a on true
left join lateral (
 select r.id,r.started_at,r.status from public.crawler_runs r
 where p.method='browser' and r.trigger in ('github_backup','github_browser_gap_fill')
 and r.status in ('running','failed') order by r.started_at desc limit 1
) active on true
left join lateral (
 select min(sr.completed_at) as queued_at
 from public.crawler_source_runs sr join public.crawler_runs r on r.id=sr.run_id
 where sr.source_id=p.source_id and not sr.success
 and r.trigger in ('supabase_cron','manual_edge_function')
 and sr.completed_at>coalesce(a.completed_at,'-infinity'::timestamptz)
) q on true;
