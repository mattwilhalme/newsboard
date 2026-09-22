-- Derive one combined outcome from persisted routing, browser runs and results.
-- Edge rows for browser-configured sources are delegation notices, not attempts.
create view public.v_crawler_attempt_status with (security_invoker=true) as
select p.source_id,
 case
  when active.id is not null and a.run_id is distinct from active.id
       and active.started_at > coalesce(a.completed_at,'-infinity'::timestamptz) then
   case when active.status='running' and active.started_at > now()-interval '10 minutes' then 'running' else 'failed' end
  when a.success = false then 'failed'
  when p.method='browser' and q.queued_at is not null
       and (a.completed_at is null or a.completed_at < now()-interval '420 seconds') then
   case when q.queued_at > now()-interval '20 minutes' then 'pending' else 'failed' end
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
grant select on public.v_crawler_attempt_status to anon,authenticated,service_role;

create or replace function public.newsboard_snapshot() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object('cacheLike',jsonb_build_object('generatedAt',now(),'sources',coalesce((select jsonb_object_agg(c.source_id,jsonb_build_object('ok',true,'updatedAt',c.observed_at,'updated_at',c.observed_at,'firstSeenAt',c.first_seen_at,'lastChangeAt',c.last_change_at,'sourceName',s.name,'item',c.item,'health',jsonb_build_object('lastAttemptAt',h.last_attempt_at,'lastAttemptSuccess',case when cs.crawl_status='success' then true when cs.crawl_status='failed' then false else null end,'crawlStatus',cs.crawl_status,'latestError',h.latest_error,'consecutiveFailures',h.consecutive_failures,'method',h.method))) from public.crawler_current c join public.sources s on s.id=c.source_id left join public.v_crawler_health h on h.source_id=c.source_id left join public.v_crawler_attempt_status cs on cs.source_id=c.source_id),'{}'::jsonb)),
'history',jsonb_build_object('generatedAt',now(),'sources',coalesce((select jsonb_object_agg(s.id,jsonb_build_object('entries',coalesce(h.entries,'[]'::jsonb))) from public.sources s left join lateral(select jsonb_agg(jsonb_build_object('title',x.title,'url',x.url,'firstSeenAt',x.first_seen,'lastSeenAt',x.last_seen,'seenCount',x.seen) order by x.last_seen) entries from(select title,url,min(observed_at) first_seen,max(observed_at) last_seen,count(*) seen from public.hero_runs where source_id=s.id and ok and url is not null group by title,url having max(observed_at)>now()-interval '7 days' or url=(select item->>'url' from public.crawler_current where source_id=s.id) order by max(observed_at) desc)x)h on true),'{}'::jsonb)));
$$;
