-- Merge one derived Story Identity into another while preserving manual routing
-- for every publisher URL. Raw crawler evidence remains unchanged.
create table newsboard_private.story_group_merges(
 id uuid primary key default gen_random_uuid(),
 source_story_id uuid not null,
 target_story_id uuid not null references public.stories(id) on delete cascade,
 source_label text not null,
 target_label text not null,
 assignments_moved integer not null,
 notes text,
 reviewer text,
 created_at timestamptz not null default now(),
 check(source_story_id<>target_story_id)
);

revoke all on newsboard_private.story_group_merges from public,anon,authenticated;
grant all on newsboard_private.story_group_merges to service_role;

create function public.newsboard_story_merge(
 p_source_story uuid,p_target_story uuid,p_notes text default null,p_reviewer text default null
) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare source_label text; target_label text; moved int;
begin
 if p_source_story=p_target_story then raise exception 'Source and target groups must be different'; end if;
 perform pg_advisory_xact_lock(794612);
 select coalesce(manual_label,canonical_label) into strict source_label from public.stories where id=p_source_story for update;
 select coalesce(manual_label,canonical_label) into strict target_label from public.stories where id=p_target_story for update;

 update newsboard_private.story_identity_corrections c set active=false,superseded_at=now()
 where c.active and exists(
  select 1 from public.story_assignments a
  where a.story_id=p_source_story and a.source_id=c.source_id and a.url=c.canonical_url
 );
 insert into newsboard_private.story_identity_corrections(
  source_id,canonical_url,target_story_id,previous_story_ids,action,notes,reviewer
 )
 select distinct a.source_id,a.url,p_target_story,array[p_source_story],'reassign',left(p_notes,2000),left(p_reviewer,200)
 from public.story_assignments a where a.story_id=p_source_story;

 update public.story_assignments set story_id=p_target_story,
  metadata=metadata||jsonb_build_object(
   'manual_correction',true,'manual_merge_source_story_id',p_source_story,
   'manual_target_story_id',p_target_story,'manual_reviewer',left(p_reviewer,200),'manual_corrected_at',now()
  ) where story_id=p_source_story;
 get diagnostics moved=row_count;
 if moved=0 then raise exception 'Source group has no assignments'; end if;

 insert into newsboard_private.story_group_merges(
  source_story_id,target_story_id,source_label,target_label,assignments_moved,notes,reviewer
 ) values(p_source_story,p_target_story,source_label,target_label,moved,left(p_notes,2000),left(p_reviewer,200));
 delete from public.stories where id=p_source_story;
 perform public.newsboard_story_rebuild(p_target_story);
 return jsonb_build_object(
  'source_story_id',p_source_story,'target_story_id',p_target_story,
  'source_label',source_label,'target_label',target_label,'assignments_moved',moved
 );
end $$;

revoke all on function public.newsboard_story_merge(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.newsboard_story_merge(uuid,uuid,text,text) to service_role;
