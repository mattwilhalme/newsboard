-- Public read RPCs expose only their shaped JSON results. Run their internal
-- ledger reads as the function owner so callers never need table privileges.
create or replace function public.newsboard_collection_health() returns jsonb
language sql stable security definer set search_path='' as $$
with constants as(select 900 healthy_s,2700 stale_s), metrics as(
 select p.source_id,s.name,p.method,c.observed_at last_success_at,
  extract(epoch from(now()-c.observed_at))::bigint last_success_age_seconds,
  a.completed_at last_attempt_at,coalesce(a.outcome,case when a.success then 'success' when a.success=false then 'crawl_failed' end) last_attempt_status,a.http_status,a.error last_error,
  coalesce(x.attempts,0) attempts_24h,coalesce(x.successes,0) successes_24h,
  case when coalesce(x.attempts,0)=0 then null else round(x.successes::numeric/x.attempts,4) end success_rate_24h,
  coalesce(cf.n,0) consecutive_failures,coalesce(cb.n,0) consecutive_blocked,
  coalesce(x.browser_attempts,0) browser_attempts_24h,
  case when coalesce(x.attempts,0)=0 then null else round(x.browser_attempts::numeric/x.attempts,4) end browser_fallback_rate_24h,
  j.status browser_fallback_state,j.next_retry_at,j.failures browser_failures,j.last_outcome browser_last_outcome,
  t.observed_at top10_observed_at,t.quality top10_quality,t.item_count top10_items,
  pb.observed_at story_processed_through,
  greatest(0,extract(epoch from(coalesce(c.observed_at,now())-coalesce(pb.observed_at,c.observed_at,now()))))::bigint story_processing_lag_seconds
 from public.crawler_publishers p join public.sources s on s.id=p.source_id left join public.crawler_current c on c.source_id=p.source_id
 left join lateral(select r.* from public.crawler_source_runs r where r.source_id=p.source_id order by r.completed_at desc limit 1)a on true
 left join lateral(select count(*) attempts,count(*) filter(where success) successes,count(*) filter(where collection_method='browser') browser_attempts from public.crawler_source_runs r where r.source_id=p.source_id and r.completed_at>=now()-interval '24 hours')x on true
 left join lateral(select count(*) n from public.crawler_source_runs r where r.source_id=p.source_id and not r.success and r.completed_at>coalesce((select max(z.completed_at) from public.crawler_source_runs z where z.source_id=p.source_id and z.success),'-infinity'))cf on true
 left join lateral(select count(*) n from public.crawler_source_runs r where r.source_id=p.source_id and r.outcome='blocked' and r.completed_at>coalesce((select max(z.completed_at) from public.crawler_source_runs z where z.source_id=p.source_id and z.outcome<>'blocked'),'-infinity'))cb on true
 left join public.crawler_browser_jobs j on j.source_id=p.source_id
 left join lateral(select r.observed_at,r.quality,r.item_count from public.top10_runs r where r.source_id=p.source_id order by r.observed_at desc limit 1)t on true
 left join lateral(select max(observed_at) observed_at from public.story_processed_batches b where b.source_id=p.source_id)pb on true
), classified as(select m.*,case
 when m.last_success_at is null then 'unavailable'
 when m.last_success_age_seconds>(select stale_s from constants) then 'stale'
 when m.last_attempt_status='blocked' then 'blocked'
 when m.last_attempt_status in('crawl_failed','infrastructure_error') or coalesce(m.success_rate_24h,1)<.9 or m.story_processing_lag_seconds>900 then 'degraded'
 else 'healthy' end health from metrics m)
select coalesce(jsonb_object_agg(source_id,to_jsonb(classified)-'source_id'),'{}'::jsonb) from classified;
$$;

-- Bound the candidate set before aggregating member and observation history.
-- This avoids multiplying both ledgers together for every recent story.
create or replace function public.newsboard_recent_stories(p_hours int default 24,p_limit int default 50) returns jsonb
language sql stable security definer set search_path='' as $$
with candidates as materialized(
 select s.id,s.canonical_label,s.first_detected_at,s.first_source_id,s.last_seen_at
 from public.stories s
 where s.last_seen_at>now()-make_interval(hours=>least(168,greatest(1,p_hours)))
 and exists(select 1 from public.story_members m where m.story_id=s.id group by m.story_id having count(distinct m.source_id)>1)
 order by s.last_seen_at desc limit least(200,greatest(1,p_limit))
)
select coalesce(jsonb_agg(jsonb_build_object(
 'story_id',c.id,'canonical_label',c.canonical_label,'first_detected_at',c.first_detected_at,
 'first_source_id',c.first_source_id,'last_seen_at',c.last_seen_at,
 'publishers_detected',m.publishers_detected,'recent_publishers',m.recent_publishers,
 'first_number_one_at',m.first_number_one_at,'publishers_reaching_number_one',m.publishers_reaching_number_one,
 'rank_changes',o.rank_changes,'headline_changes',o.headline_changes) order by c.last_seen_at desc),'[]'::jsonb)
from candidates c
cross join lateral(select count(distinct source_id) publishers_detected,
 count(distinct source_id) filter(where active and last_seen_at>now()-interval '2 hours') recent_publishers,
 min(first_number_one_at) first_number_one_at,
 count(distinct source_id) filter(where first_number_one_at is not null) publishers_reaching_number_one
 from public.story_members where story_id=c.id)m
cross join lateral(select count(*) filter(where event_type='RANK_CHANGED') rank_changes,
 count(*) filter(where event_type='HEADLINE_CHANGED') headline_changes
 from public.story_observations where story_id=c.id)o;
$$;

create or replace function public.newsboard_story_operational_health() returns jsonb
language sql stable security definer set search_path='' as $$
with state as(select max(observed_at) raw_at from public.story_raw_batches),processed as(select max(observed_at) processed_at from public.story_processed_batches),failed as(select count(*) n from public.story_processing_runs where status='failed' and started_at>now()-interval '24 hours')
select jsonb_build_object('latest_raw_observation',s.raw_at,'latest_processed_observation',p.processed_at,
 'lag_seconds',greatest(0,extract(epoch from(coalesce(s.raw_at,now())-coalesce(p.processed_at,s.raw_at,now())))::bigint),
 'unprocessed_batches',(select count(*) from public.story_raw_batches b where not exists(select 1 from public.story_processed_batches d where d.batch_key=b.batch_key)),
 'failed_runs_24h',f.n,'status',case when f.n>0 then 'degraded' when s.raw_at-p.processed_at>interval '15 minutes' then 'degraded' else 'healthy' end)
from state s cross join processed p cross join failed f;
$$;

revoke all on function public.newsboard_collection_health(),public.newsboard_recent_stories(int,int),public.newsboard_story_operational_health() from public;
grant execute on function public.newsboard_collection_health(),public.newsboard_recent_stories(int,int),public.newsboard_story_operational_health() to anon,authenticated,service_role;
