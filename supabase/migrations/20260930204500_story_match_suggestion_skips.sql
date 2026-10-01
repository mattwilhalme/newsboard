-- Persist human rejections of singleton-to-singleton merge suggestions.
create table newsboard_private.story_match_suggestion_skips(
 story_a uuid not null references public.stories(id) on delete cascade,
 story_b uuid not null references public.stories(id) on delete cascade,
 matcher_version text,
 score numeric,
 notes text,
 reviewer text,
 created_at timestamptz not null default now(),
 primary key(story_a,story_b),
 check(story_a<story_b)
);

revoke all on newsboard_private.story_match_suggestion_skips from public,anon,authenticated;
grant all on newsboard_private.story_match_suggestion_skips to service_role;

create function public.newsboard_story_suggestion_skips() returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('story_a',story_a,'story_b',story_b)),'[]'::jsonb)
 from newsboard_private.story_match_suggestion_skips;
$$;

create function public.newsboard_story_skip_suggestion(
 p_story_a uuid,p_story_b uuid,p_matcher_version text default null,p_score numeric default null,
 p_notes text default null,p_reviewer text default null
) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a uuid; b uuid;
begin
 if p_story_a=p_story_b then raise exception 'Suggestion requires two different groups'; end if;
 a:=least(p_story_a,p_story_b); b:=greatest(p_story_a,p_story_b);
 if not exists(select 1 from public.stories where id=a) or not exists(select 1 from public.stories where id=b) then
  raise exception 'Story group does not exist';
 end if;
 insert into newsboard_private.story_match_suggestion_skips(story_a,story_b,matcher_version,score,notes,reviewer)
 values(a,b,left(p_matcher_version,100),p_score,left(p_notes,2000),left(p_reviewer,200))
 on conflict(story_a,story_b) do update set matcher_version=excluded.matcher_version,score=excluded.score,
  notes=excluded.notes,reviewer=excluded.reviewer,created_at=now();
 return jsonb_build_object('story_a',a,'story_b',b,'skipped',true);
end $$;

revoke all on function public.newsboard_story_suggestion_skips(),public.newsboard_story_skip_suggestion(uuid,uuid,text,numeric,text,text) from public,anon,authenticated;
grant execute on function public.newsboard_story_suggestion_skips(),public.newsboard_story_skip_suggestion(uuid,uuid,text,numeric,text,text) to service_role;
