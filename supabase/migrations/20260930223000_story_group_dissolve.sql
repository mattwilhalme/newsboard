-- Remove a derived grouping by returning each canonical publisher URL to its
-- own singleton identity. Raw crawler evidence is never deleted.
create table newsboard_private.story_group_dissolutions(
 id uuid primary key default gen_random_uuid(),story_id uuid not null,story_label text not null,
 article_count integer not null,replacement_story_ids uuid[] not null default '{}',notes text,reviewer text,
 created_at timestamptz not null default now()
);
revoke all on newsboard_private.story_group_dissolutions from public,anon,authenticated;
grant all on newsboard_private.story_group_dissolutions to service_role;

create function public.newsboard_story_dissolve(p_story uuid,p_notes text default null,p_reviewer text default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare label text; article record; result jsonb; replacements uuid[]:='{}'; n int:=0; audit_id uuid;
begin
 perform pg_advisory_xact_lock(794612);
 select coalesce(manual_label,canonical_label) into strict label from public.stories where id=p_story for update;
 insert into newsboard_private.story_group_dissolutions(story_id,story_label,article_count,notes,reviewer)
 values(p_story,label,0,left(p_notes,2000),left(p_reviewer,200)) returning id into audit_id;
 for article in select distinct on(source_id,url) batch_key,rank,headline,source_id,url from public.story_assignments
  where story_id=p_story order by source_id,url,observed_at desc,batch_key desc,rank
 loop
  result:=public.newsboard_story_correct_article(article.batch_key,article.rank,null,article.headline,'Dissolved group: '||label,p_reviewer);
  replacements:=array_append(replacements,(result->>'target_story_id')::uuid);n:=n+1;
 end loop;
 if n=0 then raise exception 'Group has no article assignments'; end if;
 update newsboard_private.story_group_dissolutions set article_count=n,replacement_story_ids=replacements where id=audit_id;
 return jsonb_build_object('story_id',p_story,'story_label',label,'articles_dissolved',n,'replacement_story_ids',replacements);
end $$;

revoke all on function public.newsboard_story_dissolve(uuid,text,text) from public,anon,authenticated;
grant execute on function public.newsboard_story_dissolve(uuid,text,text) to service_role;
notify pgrst,'reload schema';
