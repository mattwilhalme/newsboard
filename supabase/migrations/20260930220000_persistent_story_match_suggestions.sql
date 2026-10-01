-- Persistent, versioned singleton match-review queue.
create table newsboard_private.story_match_suggestions(
 story_a uuid not null,
 story_b uuid not null,
 status text not null check(status in('pending','skipped','merged','expired')),
 matcher_version text not null,
 score numeric not null,
 evidence_hash text not null,
 evidence jsonb not null,
 first_suggested_at timestamptz not null default now(),
 last_scored_at timestamptz not null default now(),
 reviewed_at timestamptz,
 reviewer text,
 primary key(story_a,story_b),
 check(story_a<story_b)
);
create index story_match_suggestions_status_score_idx on newsboard_private.story_match_suggestions(status,score desc,last_scored_at desc);
revoke all on newsboard_private.story_match_suggestions from public,anon,authenticated;
grant all on newsboard_private.story_match_suggestions to service_role;

create function public.newsboard_story_suggestion_inputs(p_limit int default 500) returns jsonb
language sql stable security invoker set search_path='' as $$
with singleton as materialized(
 select s.id,s.canonical_label,s.manual_label,s.first_detected_at,s.last_seen_at,s.search_terms,min(m.source_id) source_id
 from public.stories s join public.story_members m on m.story_id=s.id
 where s.last_seen_at>now()-interval '48 hours'
 group by s.id having count(distinct m.source_id)=1
), pairs as materialized(
 select a.id story_a,b.id story_b,a.source_id source_a,b.source_id source_b,
  coalesce(a.manual_label,a.canonical_label) label_a,coalesce(b.manual_label,b.canonical_label) label_b,
  a.first_detected_at first_a,b.first_detected_at first_b,greatest(a.last_seen_at,b.last_seen_at) newest_at
 from singleton a join singleton b on a.id<b.id and a.source_id<>b.source_id and a.search_terms&&b.search_terms
 order by newest_at desc limit least(1000,greatest(1,p_limit))
)
select coalesce(jsonb_agg(jsonb_build_object(
 'story_a',p.story_a,'story_b',p.story_b,'source_a',p.source_a,'source_b',p.source_b,
 'label_a',p.label_a,'label_b',p.label_b,'first_a',p.first_a,'first_b',p.first_b,'newest_at',p.newest_at,
 'representatives_a',coalesce((select jsonb_agg(x order by x.observed_at desc) from(select distinct on(a.headline,a.url) a.headline title,a.url,a.source_id,a.observed_at,a.metadata#>>'{input_evidence,description}' description from public.story_assignments a where a.story_id=p.story_a order by a.headline,a.url,a.observed_at desc limit 8)x),'[]'),
 'representatives_b',coalesce((select jsonb_agg(x order by x.observed_at desc) from(select distinct on(a.headline,a.url) a.headline title,a.url,a.source_id,a.observed_at,a.metadata#>>'{input_evidence,description}' description from public.story_assignments a where a.story_id=p.story_b order by a.headline,a.url,a.observed_at desc limit 8)x),'[]')
) order by p.newest_at desc),'[]'::jsonb) from pairs p;
$$;

create function public.newsboard_story_store_suggestions(p_rows jsonb) returns int
language plpgsql security invoker set search_path='' as $$
declare x jsonb; a uuid; b uuid; changed int:=0; old_hash text; old_status text; next_status text;
begin
 update newsboard_private.story_match_suggestions q set status='expired',last_scored_at=now()
 where status='pending' and (not exists(select 1 from public.stories where id=q.story_a) or not exists(select 1 from public.stories where id=q.story_b)
  or (select count(distinct source_id) from public.story_members where story_id=q.story_a)<>1
  or (select count(distinct source_id) from public.story_members where story_id=q.story_b)<>1);
 for x in select value from jsonb_array_elements(coalesce(p_rows,'[]')) loop
  a:=least((x->>'story_a')::uuid,(x->>'story_b')::uuid);b:=greatest((x->>'story_a')::uuid,(x->>'story_b')::uuid);
  select evidence_hash,status into old_hash,old_status from newsboard_private.story_match_suggestions where story_a=a and story_b=b;
  next_status:=case when coalesce((x->>'qualifies')::boolean,false) then case when old_status='skipped' and old_hash=x->>'evidence_hash' then 'skipped' else 'pending' end else 'expired' end;
  insert into newsboard_private.story_match_suggestions(story_a,story_b,status,matcher_version,score,evidence_hash,evidence,first_suggested_at,last_scored_at,reviewed_at,reviewer)
  values(a,b,next_status,x->>'matcher_version',(x->>'score')::numeric,x->>'evidence_hash',x->'evidence',now(),now(),case when next_status='skipped' then now() end,null)
  on conflict(story_a,story_b) do update set status=excluded.status,matcher_version=excluded.matcher_version,score=excluded.score,
   evidence_hash=excluded.evidence_hash,evidence=excluded.evidence,last_scored_at=now(),
   reviewed_at=case when excluded.status='pending' then null else newsboard_private.story_match_suggestions.reviewed_at end,
   reviewer=case when excluded.status='pending' then null else newsboard_private.story_match_suggestions.reviewer end;
  changed:=changed+1;
 end loop;
 return changed;
end $$;

create function public.newsboard_story_pending_suggestions(p_limit int default 30) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce(jsonb_agg(evidence order by score desc,last_scored_at desc),'[]'::jsonb)
 from (select evidence,score,last_scored_at from newsboard_private.story_match_suggestions q
 where status='pending' and exists(select 1 from public.stories where id=q.story_a) and exists(select 1 from public.stories where id=q.story_b)
 and (select count(distinct source_id) from public.story_members where story_id=q.story_a)=1
 and (select count(distinct source_id) from public.story_members where story_id=q.story_b)=1
 order by score desc,last_scored_at desc limit least(100,greatest(1,p_limit)))x;
$$;

create or replace function public.newsboard_story_merge_reviewed(p_source_story uuid,p_target_story uuid,p_evidence jsonb,p_reviewer text default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb; a uuid:=least(p_source_story,p_target_story);b uuid:=greatest(p_source_story,p_target_story);
begin
 insert into newsboard_private.story_match_decisions(story_a,story_b,decision,matcher_version,score,evidence,reviewer)
 values(p_source_story,p_target_story,'merge',coalesce(p_evidence->>'matcher_version','unknown'),nullif(p_evidence->>'score','')::numeric,coalesce(p_evidence,'{}'),left(p_reviewer,200));
 update newsboard_private.story_match_suggestions set status='merged',reviewed_at=now(),reviewer=left(p_reviewer,200) where story_a=a and story_b=b;
 result:=public.newsboard_story_merge(p_source_story,p_target_story,'Approved matcher suggestion',p_reviewer);return result;
end $$;

create or replace function public.newsboard_story_skip_suggestion_reviewed(p_story_a uuid,p_story_b uuid,p_evidence jsonb,p_reviewer text default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;a uuid:=least(p_story_a,p_story_b);b uuid:=greatest(p_story_a,p_story_b);
begin
 result:=public.newsboard_story_skip_suggestion(p_story_a,p_story_b,p_evidence->>'matcher_version',nullif(p_evidence->>'score','')::numeric,'Skipped matcher suggestion',p_reviewer);
 update newsboard_private.story_match_suggestions set status='skipped',reviewed_at=now(),reviewer=left(p_reviewer,200) where story_a=a and story_b=b;
 insert into newsboard_private.story_match_decisions(story_a,story_b,decision,matcher_version,score,evidence,reviewer)
 values(p_story_a,p_story_b,'skip',coalesce(p_evidence->>'matcher_version','unknown'),nullif(p_evidence->>'score','')::numeric,coalesce(p_evidence,'{}'),left(p_reviewer,200));return result;
end $$;

revoke all on function public.newsboard_story_suggestion_inputs(int),public.newsboard_story_store_suggestions(jsonb),public.newsboard_story_pending_suggestions(int) from public,anon,authenticated;
grant execute on function public.newsboard_story_suggestion_inputs(int),public.newsboard_story_store_suggestions(jsonb),public.newsboard_story_pending_suggestions(int) to service_role;
notify pgrst,'reload schema';
