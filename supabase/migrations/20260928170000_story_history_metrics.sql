-- Product-ready history summary derived only from Newsboard observations.
create or replace function public.newsboard_story_history(p_story uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
with target as(select * from public.stories where id=p_story), member_stats as(
 select count(*) publishers_detected,max(first_seen_at) peak_detected_at,min(first_number_one_at) first_number_one_at,
  count(*) filter(where first_number_one_at is not null) publishers_reaching_number_one,
  sum(extract(epoch from(last_seen_at-first_seen_at)))::bigint observed_persistence_seconds
 from public.story_members where story_id=p_story
), event_stats as(
 select count(*) filter(where event_type='RANK_CHANGED') rank_changes,
  count(*) filter(where event_type='HEADLINE_CHANGED') headline_changes,
  count(*) filter(where event_type in('PUBLISHER_PICKUP','FIRST_DETECTED')) detections
 from public.story_observations where story_id=p_story
)
select jsonb_build_object('story',to_jsonb(s),
 'publisher_count',(select count(*) from public.story_members where story_id=s.id and active and last_seen_at>now()-interval '2 hours'),
 'current_number_ones',(select count(*) from public.story_members where story_id=s.id and active and current_rank=1 and last_seen_at>now()-interval '2 hours'),
 'metrics',jsonb_build_object('publishers_detected',m.publishers_detected,'peak_publisher_coverage',m.publishers_detected,'peak_detected_at',m.peak_detected_at,
  'time_to_peak_seconds',greatest(0,extract(epoch from(m.peak_detected_at-s.first_detected_at)))::bigint,
  'first_number_one_at',m.first_number_one_at,'time_to_number_one_seconds',case when m.first_number_one_at is null then null else greatest(0,extract(epoch from(m.first_number_one_at-s.first_detected_at)))::bigint end,
  'publishers_reaching_number_one',m.publishers_reaching_number_one,'observed_persistence_seconds',m.observed_persistence_seconds,
  'rank_changes',e.rank_changes,'headline_changes',e.headline_changes),
 'semantics',jsonb_build_object('time_basis','newsboard_observation','first_detection_label','First detected by Newsboard','publication_time_authoritative',false),
 'members',coalesce((select jsonb_agg(to_jsonb(x) order by x.first_seen_at,x.source_id) from(
  select m.*,p.name publisher,extract(epoch from(m.last_seen_at-m.first_seen_at))::bigint observed_duration_seconds
  from public.story_members m join public.sources p on p.id=m.source_id where m.story_id=s.id)x),'[]'::jsonb),
 'events',coalesce((select jsonb_agg(x order by x.observed_at,x.event_type) from(select o.*,p.name publisher from public.story_observations o join public.sources p on p.id=o.source_id where o.story_id=s.id order by o.observed_at,o.event_type limit 1000)x),'[]'::jsonb),
 'events_truncated',(select count(*)>1000 from public.story_observations where story_id=s.id))
from target s cross join member_stats m cross join event_stats e;
$$;
revoke all on function public.newsboard_story_history(uuid) from public,anon,authenticated;
grant execute on function public.newsboard_story_history(uuid) to anon,authenticated,service_role;
