-- Report health from effective collection cycles rather than raw attempt rows.
-- Browser routing notices are not collection attempts, and a successful browser
-- fallback recovers its associated failed HTTP primary cycle.
create or replace function newsboard_private.newsboard_collection_health() returns jsonb
language sql stable security definer set search_path='' as $$
with constants as (
  select 900::bigint healthy_s,2700::bigint stale_s
),
http_cycles as materialized (
  select p.source_id,r.completed_at,
    case
      when r.success then true
      when coalesce(br.success,false) then true
      else false
    end effective_success,
    case
      when r.success then 'success'
      when coalesce(br.success,false) then 'success'
      when j.status in('pending','running') and j.deadline_at>now() then j.status
      else coalesce(br.outcome,r.outcome,case when r.success then 'success' else 'crawl_failed' end)
    end effective_status,
    case when coalesce(br.success,false) then br.completed_at else r.completed_at end effective_completed_at,
    case when coalesce(br.success,false) then br.http_status else r.http_status end effective_http_status,
    case when coalesce(br.success,false) then null else coalesce(br.error,r.error) end effective_error,
    r.outcome primary_status,r.http_status primary_http_status,r.error primary_error,
    coalesce(br.success,false) recovered_by_fallback
  from public.crawler_publishers p
  join public.crawler_source_runs r on r.source_id=p.source_id
  join public.crawler_runs rr on rr.id=r.run_id and rr.trigger in('supabase_cron','manual_edge_function')
  left join public.crawler_browser_jobs j on j.source_id=p.source_id and j.primary_run_id=r.run_id
  left join lateral(
    select b.* from public.crawler_source_runs b join public.crawler_runs rb on rb.id=b.run_id
    where not r.success and b.source_id=r.source_id and rb.trigger in('github_backup','github_browser_gap_fill')
      and b.completed_at>=r.completed_at
      and b.completed_at<coalesce((select min(n.completed_at) from public.crawler_source_runs n
        join public.crawler_runs nr on nr.id=n.run_id
        where n.source_id=r.source_id and nr.trigger in('supabase_cron','manual_edge_function') and n.completed_at>r.completed_at),'infinity')
    order by b.completed_at limit 1
  )br on true
  where p.method='http' and r.completed_at>=now()-interval '24 hours'
),
browser_cycles as (
  select p.source_id,r.completed_at,r.success effective_success,
    coalesce(r.outcome,case when r.success then 'success' else 'crawl_failed' end) effective_status,
    r.completed_at effective_completed_at,r.http_status effective_http_status,r.error effective_error,
    null::text primary_status,null::integer primary_http_status,null::text primary_error,false recovered_by_fallback
  from public.crawler_publishers p
  join public.crawler_source_runs r on r.source_id=p.source_id
  join public.crawler_runs rr on rr.id=r.run_id and rr.trigger in('github_backup','github_browser_gap_fill')
  where p.method='browser' and r.completed_at>=now()-interval '24 hours'
),
cycles as (
  select * from http_cycles
  union all
  select * from browser_cycles
),
latest_cycle as (
  select distinct on(source_id) * from cycles order by source_id,effective_completed_at desc
),
cycle_rates as (
  select source_id,count(*) attempts,count(*) filter(where effective_success) successes,
    count(*) filter(where recovered_by_fallback) recovered
  from cycles where effective_completed_at>=now()-interval '24 hours' group by source_id
),
metrics as (
 select p.source_id,s.name,p.method,c.observed_at last_success_at,
  extract(epoch from(now()-c.observed_at))::bigint last_success_age_seconds,
  lc.effective_completed_at last_attempt_at,lc.effective_status last_attempt_status,
  lc.effective_http_status http_status,lc.effective_error last_error,
  lc.primary_status last_primary_attempt_status,lc.primary_http_status primary_http_status,
  lc.primary_error last_primary_error,lc.recovered_by_fallback,
  coalesce(x.attempts,0) attempts_24h,coalesce(x.successes,0) successes_24h,
  case when coalesce(x.attempts,0)=0 then null else round(x.successes::numeric/x.attempts,4) end success_rate_24h,
  coalesce(x.recovered,0) recovered_by_fallback_24h,
  coalesce(cf.n,0) consecutive_failures,coalesce(cb.n,0) consecutive_blocked,
  case when p.method='browser' then coalesce(x.attempts,0) else coalesce(x.recovered,0) end browser_attempts_24h,
  case when p.method='browser' or coalesce(x.attempts,0)=0 then null else round(x.recovered::numeric/x.attempts,4) end browser_fallback_rate_24h,
  j.status browser_fallback_state,j.next_retry_at,j.failures browser_failures,j.last_outcome browser_last_outcome,
  t.observed_at top10_observed_at,t.quality top10_quality,t.item_count top10_items,
  pb.observed_at story_processed_through,
  greatest(0,extract(epoch from(coalesce(c.observed_at,now())-coalesce(pb.observed_at,c.observed_at,now()))))::bigint story_processing_lag_seconds
 from public.crawler_publishers p join public.sources s on s.id=p.source_id
 left join public.crawler_current c on c.source_id=p.source_id
 left join latest_cycle lc on lc.source_id=p.source_id
 left join cycle_rates x on x.source_id=p.source_id
 left join lateral(select count(*) n from cycles z where z.source_id=p.source_id and not z.effective_success and z.effective_completed_at>coalesce((select max(q.effective_completed_at) from cycles q where q.source_id=p.source_id and q.effective_success),'-infinity'))cf on true
 left join lateral(select count(*) n from cycles z where z.source_id=p.source_id and z.effective_status='blocked' and z.effective_completed_at>coalesce((select max(q.effective_completed_at) from cycles q where q.source_id=p.source_id and q.effective_status<>'blocked'),'-infinity'))cb on true
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

revoke all on function newsboard_private.newsboard_collection_health() from public;
grant execute on function newsboard_private.newsboard_collection_health() to anon,authenticated,service_role;

notify pgrst,'reload schema';
