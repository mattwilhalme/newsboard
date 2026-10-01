-- Private operations used by the localhost Story Review console.
-- Labels are presentation metadata; raw observations remain unchanged.
create table newsboard_private.story_label_corrections(
 id uuid primary key default gen_random_uuid(),
 story_id uuid not null references public.stories(id) on delete cascade,
 previous_label text,
 new_label text not null,
 notes text,
 reviewer text,
 created_at timestamptz not null default now()
);

revoke all on newsboard_private.story_label_corrections from public,anon,authenticated;
grant all on newsboard_private.story_label_corrections to service_role;

create function public.newsboard_story_set_label(
 p_story uuid,p_label text,p_notes text default null,p_reviewer text default null
) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare previous text; cleaned text;
begin
 cleaned:=nullif(left(trim(coalesce(p_label,'')),500),'');
 if cleaned is null then raise exception 'A non-empty label is required'; end if;
 select coalesce(manual_label,canonical_label) into strict previous from public.stories where id=p_story for update;
 update public.stories set manual_label=cleaned,updated_at=now() where id=p_story;
 insert into newsboard_private.story_label_corrections(story_id,previous_label,new_label,notes,reviewer)
 values(p_story,previous,cleaned,left(p_notes,2000),left(p_reviewer,200));
 return jsonb_build_object('story_id',p_story,'previous_label',previous,'label',cleaned);
end $$;

revoke all on function public.newsboard_story_set_label(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.newsboard_story_set_label(uuid,text,text,text) to service_role;
