-- Human evaluation labels stay private and never mutate automated assignments.
create table public.story_identity_audits(
 id uuid primary key default gen_random_uuid(),story_id uuid not null references public.stories(id) on delete cascade,
 verdict text not null check(verdict in('correct','false_merge','false_split','uncertain','missing_observation')),
 notes text,reviewer text,created_at timestamptz not null default now()
);
create index story_identity_audits_story_time on public.story_identity_audits(story_id,created_at desc);
alter table public.story_identity_audits enable row level security;
revoke all on public.story_identity_audits from public,anon,authenticated;
grant all on public.story_identity_audits to service_role;
create policy service_access on public.story_identity_audits for all to service_role using(true) with check(true);

create function public.newsboard_story_audit_record(p_story uuid,p_verdict text,p_notes text default null,p_reviewer text default null) returns uuid
language plpgsql security invoker set search_path='' as $$
declare result uuid;
begin
 if p_verdict not in('correct','false_merge','false_split','uncertain','missing_observation') then raise exception 'Invalid audit verdict'; end if;
 insert into public.story_identity_audits(story_id,verdict,notes,reviewer) values(p_story,p_verdict,left(p_notes,2000),left(p_reviewer,200)) returning id into result;
 return result;
end $$;

-- Discoverable historical identities without exposing the private assignment ledger.
create function public.newsboard_recent_stories(p_hours int default 24,p_limit int default 50) returns jsonb
language sql stable security invoker set search_path='' as $$
select coalesce(jsonb_agg(x order by x.last_seen_at desc),'[]'::jsonb) from(
 select s.id story_id,s.canonical_label,s.first_detected_at,s.first_source_id,s.last_seen_at,
  count(distinct m.source_id) publishers_detected,count(distinct m.source_id) filter(where m.active and m.last_seen_at>now()-interval '2 hours') recent_publishers,
  min(m.first_number_one_at) first_number_one_at,count(distinct m.source_id) filter(where m.first_number_one_at is not null) publishers_reaching_number_one,
  count(distinct o.id) filter(where o.event_type='RANK_CHANGED') rank_changes,count(distinct o.id) filter(where o.event_type='HEADLINE_CHANGED') headline_changes
 from public.stories s join public.story_members m on m.story_id=s.id left join public.story_observations o on o.story_id=s.id
 where s.last_seen_at>now()-make_interval(hours=>least(168,greatest(1,p_hours)))
 group by s.id having count(distinct m.source_id)>1
 order by s.last_seen_at desc limit least(200,greatest(1,p_limit))
)x;
$$;

create function public.newsboard_story_operational_health() returns jsonb
language sql stable security invoker set search_path='' as $$
with state as(select max(observed_at) raw_at from public.story_raw_batches),processed as(select max(observed_at) processed_at from public.story_processed_batches), failed as(select count(*) n from public.story_processing_runs where status='failed' and started_at>now()-interval '24 hours')
select jsonb_build_object('latest_raw_observation',s.raw_at,'latest_processed_observation',p.processed_at,
 'lag_seconds',greatest(0,extract(epoch from(coalesce(s.raw_at,now())-coalesce(p.processed_at,s.raw_at,now())))::bigint,
 'unprocessed_batches',(select count(*) from public.story_raw_batches b where not exists(select 1 from public.story_processed_batches d where d.batch_key=b.batch_key)),
 'failed_runs_24h',f.n,'status',case when f.n>0 then 'degraded' when s.raw_at-p.processed_at>interval '15 minutes' then 'degraded' else 'healthy' end)
from state s cross join processed p cross join failed f;
$$;

revoke all on function public.newsboard_story_audit_record(uuid,text,text,text),public.newsboard_recent_stories(int,int),public.newsboard_story_operational_health() from public,anon,authenticated;
grant execute on function public.newsboard_story_audit_record(uuid,text,text,text) to service_role;
grant execute on function public.newsboard_recent_stories(int,int),public.newsboard_story_operational_health() to anon,authenticated,service_role;
