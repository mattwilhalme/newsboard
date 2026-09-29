-- Manual identity corrections remain private, auditable, and persistent across
-- future automated batches. Raw crawler evidence is never mutated.
alter table public.stories add column manual_label text;
create table newsboard_private.story_identity_corrections(
 id uuid primary key default gen_random_uuid(),
 source_id text not null references public.sources(id),
 canonical_url text not null,
 target_story_id uuid not null references public.stories(id) on delete cascade,
 previous_story_ids uuid[] not null default '{}',
 action text not null check(action in('reassign','create')),
 notes text,
 reviewer text,
 active boolean not null default true,
 created_at timestamptz not null default now(),
 superseded_at timestamptz
);
create unique index story_identity_corrections_active_article
 on newsboard_private.story_identity_corrections(source_id,canonical_url) where active;
create index story_identity_corrections_story_time
 on newsboard_private.story_identity_corrections(target_story_id,created_at desc);
revoke all on newsboard_private.story_identity_corrections from public,anon,authenticated;
grant usage on schema newsboard_private to service_role;
grant all on newsboard_private.story_identity_corrections to service_role;

create function public.newsboard_story_manual_targets(p_source text,p_urls text[]) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_object_agg(c.canonical_url,c.target_story_id),'{}'::jsonb)
 from newsboard_private.story_identity_corrections c
 where c.active and c.source_id=p_source and c.canonical_url=any(coalesce(p_urls,'{}'::text[]));
$$;

create function public.newsboard_story_corrections(p_limit int default 100) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at desc),'[]'::jsonb)
 from (select * from newsboard_private.story_identity_corrections order by created_at desc limit least(500,greatest(1,p_limit)))c;
$$;

create function public.newsboard_story_correct_article(
 p_batch_key text,p_rank int,p_target_story uuid default null,p_new_label text default null,
 p_notes text default null,p_reviewer text default null
) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a public.story_assignments; target uuid; old_ids uuid[]; old_id uuid; moved int; action_name text;
begin
 perform pg_advisory_xact_lock(794612);
 select * into strict a from public.story_assignments where batch_key=p_batch_key and rank=p_rank;
 select coalesce(array_agg(distinct story_id),'{}') into old_ids from public.story_assignments where source_id=a.source_id and url=a.url;
 if p_target_story is null then
  target:=gen_random_uuid(); action_name:='create';
  insert into public.stories(id,canonical_label,manual_label,first_detected_at,first_source_id,last_seen_at)
  values(target,a.headline,coalesce(nullif(left(trim(p_new_label),500),''),a.headline),a.observed_at,a.source_id,a.observed_at);
 else
  target:=p_target_story; action_name:='reassign';
  if not exists(select 1 from public.stories where id=target) then raise exception 'Target story does not exist'; end if;
 end if;
 update newsboard_private.story_identity_corrections set active=false,superseded_at=now()
 where active and source_id=a.source_id and canonical_url=a.url;
 insert into newsboard_private.story_identity_corrections(source_id,canonical_url,target_story_id,previous_story_ids,action,notes,reviewer)
 values(a.source_id,a.url,target,old_ids,action_name,left(p_notes,2000),left(p_reviewer,200));
 update public.story_assignments set story_id=target,
  metadata=metadata||jsonb_build_object('manual_correction',true,'manual_target_story_id',target,'manual_reviewer',left(p_reviewer,200),'manual_corrected_at',now())
 where source_id=a.source_id and url=a.url;
 get diagnostics moved=row_count;
 foreach old_id in array old_ids loop
  if old_id<>target then
   if exists(select 1 from public.story_assignments where story_id=old_id) then
    delete from public.story_members m where m.story_id=old_id
     and not exists(select 1 from public.story_assignments x where x.story_id=old_id and x.source_id=m.source_id);
    perform public.newsboard_story_rebuild(old_id);
   else delete from public.stories where id=old_id; end if;
  end if;
 end loop;
 perform public.newsboard_story_rebuild(target);
 return jsonb_build_object('target_story_id',target,'source_id',a.source_id,'url',a.url,'assignments_moved',moved,'action',action_name,'previous_story_ids',old_ids);
end $$;

create or replace function public.newsboard_story_history(p_story uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 with target as(select s.*,coalesce(s.manual_label,s.canonical_label) display_label from public.stories s where s.id=p_story)
 select jsonb_build_object(
  'story',(to_jsonb(s)-'display_label')||jsonb_build_object('canonical_label',s.display_label),
  'metrics',jsonb_build_object(
   'publishers_detected',(select count(*) from public.story_members where story_id=s.id),
   'time_to_peak_seconds',(select extract(epoch from(max(first_seen_at)-s.first_detected_at))::bigint from public.story_members where story_id=s.id),
   'time_to_number_one_seconds',(select extract(epoch from(min(first_number_one_at)-s.first_detected_at))::bigint from public.story_members where story_id=s.id and first_number_one_at is not null),
   'rank_changes',(select count(*) from public.story_observations where story_id=s.id and event_type='RANK_CHANGED'),
   'headline_changes',(select count(*) from public.story_observations where story_id=s.id and event_type='HEADLINE_CHANGED')),
  'publisher_count',(select count(*) from public.story_members where story_id=s.id and active and last_seen_at>now()-interval '2 hours'),
  'current_number_ones',(select count(*) from public.story_members where story_id=s.id and active and current_rank=1 and last_seen_at>now()-interval '2 hours'),
  'members',coalesce((select jsonb_agg(x order by x.first_seen_at,x.source_id) from(select m.*,p.name publisher,
   extract(epoch from(m.last_seen_at-m.first_seen_at))::bigint observed_duration_seconds
   from public.story_members m join public.sources p on p.id=m.source_id where m.story_id=s.id)x),'[]'::jsonb),
  'events',coalesce((select jsonb_agg(x order by x.observed_at,x.event_type) from(select o.*,p.name publisher from public.story_observations o join public.sources p on p.id=o.source_id where o.story_id=s.id order by o.observed_at,o.event_type limit 1000)x),'[]'::jsonb),
  'events_truncated',(select count(*)>1000 from public.story_observations where story_id=s.id)) from target s;
$$;

-- Radar summary stays bounded and exposes only derived public evidence.
create or replace function public.newsboard_recent_stories(p_hours int default 24,p_limit int default 50) returns jsonb
language sql stable security definer set search_path='' as $$
with candidates as materialized(
 select s.id,s.canonical_label,s.manual_label,s.first_detected_at,s.first_source_id,s.last_seen_at
 from public.stories s
 where s.last_seen_at>now()-make_interval(hours=>least(168,greatest(1,p_hours)))
 and exists(select 1 from public.story_members m where m.story_id=s.id group by m.story_id having count(distinct m.source_id)>1)
 order by s.last_seen_at desc limit least(200,greatest(1,p_limit))
)
select coalesce(jsonb_agg(jsonb_build_object(
 'story_id',c.id,'canonical_label',coalesce(c.manual_label,c.canonical_label),'first_detected_at',c.first_detected_at,
 'first_source_id',c.first_source_id,'last_seen_at',c.last_seen_at,
 'publishers_detected',m.publishers_detected,'recent_publishers',m.recent_publishers,
 'publisher_ids',m.publisher_ids,'active_source_ids',m.active_source_ids,
 'second_publisher_at',m.second_publisher_at,
 'first_number_one_at',m.first_number_one_at,'publishers_reaching_number_one',m.publishers_reaching_number_one,
 'rank_changes',o.rank_changes,'headline_changes',o.headline_changes) order by c.last_seen_at desc),'[]'::jsonb)
from candidates c
cross join lateral(
 select count(distinct source_id) publishers_detected,
  count(distinct source_id) filter(where active and last_seen_at>now()-interval '2 hours') recent_publishers,
  array_agg(distinct source_id order by source_id) publisher_ids,
  coalesce(array_agg(distinct source_id order by source_id) filter(where active and last_seen_at>now()-interval '2 hours'),'{}'::text[]) active_source_ids,
  (select first_seen_at from public.story_members x where x.story_id=c.id order by first_seen_at,source_id offset 1 limit 1) second_publisher_at,
  min(first_number_one_at) first_number_one_at,
  count(distinct source_id) filter(where first_number_one_at is not null) publishers_reaching_number_one
 from public.story_members where story_id=c.id)m
cross join lateral(select count(*) filter(where event_type='RANK_CHANGED') rank_changes,
 count(*) filter(where event_type='HEADLINE_CHANGED') headline_changes
 from public.story_observations where story_id=c.id)o;
$$;

revoke all on function public.newsboard_story_manual_targets(text,text[]),public.newsboard_story_corrections(int),public.newsboard_story_correct_article(text,int,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.newsboard_story_manual_targets(text,text[]),public.newsboard_story_corrections(int),public.newsboard_story_correct_article(text,int,uuid,text,text,text) to service_role;
revoke all on function public.newsboard_recent_stories(int,int) from public;
grant execute on function public.newsboard_recent_stories(int,int) to anon,authenticated,service_role;
revoke all on function public.newsboard_story_history(uuid) from public;
grant execute on function public.newsboard_story_history(uuid) to anon,authenticated,service_role;
