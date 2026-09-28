-- Derived operational health: evidence remains in crawler/source/top10/story ledgers.
create function public.newsboard_collection_health_thresholds() returns jsonb
language sql immutable set search_path='' as $$
 select '{"healthy_seconds":900,"stale_seconds":2700,"success_window_hours":24,"story_lag_warning_seconds":900}'::jsonb;
$$;

create function public.newsboard_collection_health() returns jsonb
language sql stable security invoker set search_path='' as $$
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

-- Private audit surface for sampling matcher behavior and unprocessed observations.
create function public.newsboard_story_assignment_diagnostics(p_limit int default 200) returns jsonb
language sql stable security invoker set search_path='' as $$
 with freshness as(select (select max(observed_at) from public.story_raw_batches) raw_at,(select max(observed_at) from public.story_processed_batches) processed_at)
 select jsonb_build_object(
  'assignments',coalesce((select jsonb_agg(x) from(select a.story_id,a.batch_key,a.source_id,a.observed_at,a.headline,a.url,a.rank,a.metadata as match_evidence,s.first_detected_at,s.first_source_id from public.story_assignments a join public.stories s on s.id=a.story_id order by a.observed_at desc limit greatest(1,least(p_limit,500)))x),'[]'::jsonb),
  'unprocessed_batches',coalesce((select jsonb_agg(x) from(select b.batch_key,b.source_id,b.observed_at,b.scope,jsonb_array_length(b.items) item_count from public.story_raw_batches b where not exists(select 1 from public.story_processed_batches p where p.batch_key=b.batch_key) order by b.observed_at desc limit greatest(1,least(p_limit,500)))x),'[]'::jsonb),
  'latest_raw_observation',raw_at,
  'latest_processed_observation',processed_at,
  'story_processing_lag_seconds',greatest(0,extract(epoch from(coalesce(raw_at,now())-coalesce(processed_at,raw_at,now())))::bigint))
 from freshness;
$$;

revoke all on function public.newsboard_collection_health_thresholds(),public.newsboard_collection_health(),public.newsboard_story_assignment_diagnostics(int) from public,anon,authenticated;
grant execute on function public.newsboard_collection_health_thresholds(),public.newsboard_collection_health() to anon,authenticated,service_role;
grant execute on function public.newsboard_story_assignment_diagnostics(int) to service_role;
