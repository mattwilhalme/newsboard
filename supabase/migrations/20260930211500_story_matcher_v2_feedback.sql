-- Matcher v2 retains lightweight input evidence and captures reviewed pair
-- snapshots for reproducible precision analysis. No raw evidence is mutated.
create table newsboard_private.story_match_decisions(
 id uuid primary key default gen_random_uuid(),
 story_a uuid not null,
 story_b uuid not null,
 decision text not null check(decision in('merge','skip')),
 matcher_version text not null,
 score numeric,
 evidence jsonb not null default '{}',
 reviewer text,
 created_at timestamptz not null default now(),
 check(story_a<>story_b)
);
create index story_match_decisions_time_idx on newsboard_private.story_match_decisions(created_at desc);
revoke all on newsboard_private.story_match_decisions from public,anon,authenticated;
grant all on newsboard_private.story_match_decisions to service_role;

create or replace function public.newsboard_story_candidates(p_terms text[],p_at timestamptz,p_source text,p_urls text[])
returns jsonb language sql security invoker set search_path='' as $$
 with candidates as (
 select s.* from public.stories s
 where s.last_seen_at>=p_at-interval '48 hours' and s.first_detected_at<=p_at+interval '48 hours'
 and (s.search_terms && p_terms or exists(select 1 from public.story_assignments a where a.story_id=s.id and a.source_id=p_source and a.url=any(p_urls) and a.observed_at between p_at-interval '48 hours' and p_at+interval '48 hours'))
 order by (select count(*) from unnest(s.search_terms) t where t=any(p_terms)) desc,s.last_seen_at desc limit 100
 ) select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'first_detected_at',s.first_detected_at,'last_seen_at',s.last_seen_at,
 'representatives',coalesce((select jsonb_agg(x) from (
 select distinct on (a.source_id,a.headline,a.url) a.source_id,a.headline as title,a.url,a.observed_at,
  a.metadata#>>'{input_evidence,description}' as description
 from public.story_assignments a where a.story_id=s.id and a.observed_at between p_at-interval '48 hours' and p_at+interval '48 hours'
 order by a.source_id,a.headline,a.url,abs(extract(epoch from(a.observed_at-p_at))) limit 24)x),'[]'::jsonb))),'[]'::jsonb) from candidates s;
$$;

create function public.newsboard_story_merge_reviewed(
 p_source_story uuid,p_target_story uuid,p_evidence jsonb,p_reviewer text default null
) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 insert into newsboard_private.story_match_decisions(story_a,story_b,decision,matcher_version,score,evidence,reviewer)
 values(p_source_story,p_target_story,'merge',coalesce(p_evidence->>'matcher_version','unknown'),
  nullif(p_evidence->>'score','')::numeric,coalesce(p_evidence,'{}'),left(p_reviewer,200));
 result:=public.newsboard_story_merge(p_source_story,p_target_story,'Approved matcher suggestion',p_reviewer);
 return result;
end $$;

create function public.newsboard_story_skip_suggestion_reviewed(
 p_story_a uuid,p_story_b uuid,p_evidence jsonb,p_reviewer text default null
) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 result:=public.newsboard_story_skip_suggestion(p_story_a,p_story_b,p_evidence->>'matcher_version',
  nullif(p_evidence->>'score','')::numeric,'Skipped matcher suggestion',p_reviewer);
 insert into newsboard_private.story_match_decisions(story_a,story_b,decision,matcher_version,score,evidence,reviewer)
 values(p_story_a,p_story_b,'skip',coalesce(p_evidence->>'matcher_version','unknown'),
  nullif(p_evidence->>'score','')::numeric,coalesce(p_evidence,'{}'),left(p_reviewer,200));
 return result;
end $$;

create function public.newsboard_story_match_evaluation(p_limit int default 1000) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(d) order by d.created_at desc),'[]'::jsonb)
 from (select * from newsboard_private.story_match_decisions order by created_at desc limit least(5000,greatest(1,p_limit)))d;
$$;

revoke all on function public.newsboard_story_merge_reviewed(uuid,uuid,jsonb,text),public.newsboard_story_skip_suggestion_reviewed(uuid,uuid,jsonb,text),public.newsboard_story_match_evaluation(int) from public,anon,authenticated;
grant execute on function public.newsboard_story_merge_reviewed(uuid,uuid,jsonb,text),public.newsboard_story_skip_suggestion_reviewed(uuid,uuid,jsonb,text),public.newsboard_story_match_evaluation(int) to service_role;

notify pgrst,'reload schema';
