-- Keep privileged implementations outside the exposed API schema. The public
-- functions below are invoker-security wrappers returning the same shaped JSON.
alter function public.newsboard_collection_health() set schema newsboard_private;
alter function public.newsboard_recent_stories(integer,integer) set schema newsboard_private;
alter function public.newsboard_story_operational_health() set schema newsboard_private;

grant usage on schema newsboard_private to anon,authenticated,service_role;
revoke execute on all functions in schema newsboard_private from public,anon,authenticated;
grant execute on all functions in schema newsboard_private to service_role;
grant execute on function newsboard_private.newsboard_collection_health(),newsboard_private.newsboard_recent_stories(integer,integer),newsboard_private.newsboard_story_operational_health() to anon,authenticated;
alter default privileges in schema newsboard_private revoke execute on functions from public;
alter default privileges in schema newsboard_private grant execute on functions to service_role;

create function public.newsboard_collection_health() returns jsonb language sql stable security invoker set search_path='' as $$
 select newsboard_private.newsboard_collection_health();
$$;
create function public.newsboard_recent_stories(p_hours integer default 24,p_limit integer default 50) returns jsonb language sql stable security invoker set search_path='' as $$
 select newsboard_private.newsboard_recent_stories(p_hours,p_limit);
$$;
create function public.newsboard_story_operational_health() returns jsonb language sql stable security invoker set search_path='' as $$
 select newsboard_private.newsboard_story_operational_health();
$$;
revoke all on function public.newsboard_collection_health(),public.newsboard_recent_stories(integer,integer),public.newsboard_story_operational_health() from public,anon,authenticated;
grant execute on function public.newsboard_collection_health(),public.newsboard_recent_stories(integer,integer),public.newsboard_story_operational_health() to anon,authenticated,service_role;

create index if not exists feed_sources_publisher_idx on public.feed_sources(publisher_id);
create index if not exists feed_poll_runs_feed_idx on public.feed_poll_runs(feed_id);
create index if not exists publisher_articles_first_feed_idx on public.publisher_articles(first_feed_id);
create index if not exists publisher_articles_last_feed_idx on public.publisher_articles(last_feed_id);
create index if not exists crawler_browser_jobs_primary_run_idx on public.crawler_browser_jobs(primary_run_id);
create index if not exists crawler_browser_jobs_browser_run_idx on public.crawler_browser_jobs(browser_run_id);
create index if not exists story_group_merges_target_idx on newsboard_private.story_group_merges(target_story_id);
create index if not exists story_label_corrections_story_idx on newsboard_private.story_label_corrections(story_id);
-- The primary key already covers story_a; only the second FK needs another index.
create index if not exists story_match_suggestion_skips_story_b_idx on newsboard_private.story_match_suggestion_skips(story_b);

create or replace function public.newsboard_story_commit(p_run uuid,p_batch_key text,p_assignments jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare b public.story_raw_batches;x jsonb;sid uuid;affected uuid[]:=array[]::uuid[];st uuid;
begin
 perform pg_advisory_xact_lock(794612);
 if not exists(select 1 from public.story_worker_state where id and lock_owner=p_run and lock_until>now()) then raise exception 'Story worker lease lost'; end if;
 if exists(select 1 from public.story_processed_batches where batch_key=p_batch_key) then return false; end if;
 select * into strict b from public.newsboard_story_raw_batch(p_batch_key);
 if jsonb_array_length(p_assignments)<>jsonb_array_length(b.items) or jsonb_array_length(p_assignments)=0 then raise exception 'Incomplete story assignments'; end if;
 select coalesce(array_agg(story_id),array[]::uuid[]) into affected from public.story_members where source_id=b.source_id and(active or last_seen_at>=b.observed_at);
 insert into public.story_processed_batches(batch_key,source_id,observed_at,scope,snapshot_id,top10_run_id) values(b.batch_key,b.source_id,b.observed_at,b.scope,b.snapshot_id,b.top10_run_id);
 for x in select value from jsonb_array_elements(p_assignments) loop
  sid:=(x->>'story_id')::uuid;
  insert into public.stories(id,canonical_label,first_detected_at,first_source_id,last_seen_at) values(sid,x->>'title',b.observed_at,b.source_id,b.observed_at) on conflict(id) do nothing;
  insert into public.story_assignments(batch_key,rank,story_id,source_id,observed_at,headline,headline_norm,url,fingerprint,published_at,terms,metadata)
  values(b.batch_key,(x->>'rank')::int,sid,b.source_id,b.observed_at,x->>'title',x->>'normalized',x->>'url',x->>'fingerprint',(x->>'published_at')::timestamptz,array(select jsonb_array_elements_text(x->'terms')),x->'match');
  affected:=array_append(affected,sid);
 end loop;
 for st in select distinct unnest(affected) loop perform public.newsboard_story_rebuild(st);end loop;
 update public.story_processing_runs set batches_processed=batches_processed+1 where id=p_run;
 update public.story_worker_state set lock_until=now()+interval '3 minutes' where id and lock_owner=p_run;
 return true;
end $$;

create or replace function public.newsboard_story_dissolve(p_story uuid,p_notes text default null,p_reviewer text default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare label text;article record;result jsonb;replacements uuid[]:=array[]::uuid[];n int:=0;audit_id uuid;
begin
 perform pg_advisory_xact_lock(794612);
 select coalesce(manual_label,canonical_label) into strict label from public.stories where id=p_story for update;
 insert into newsboard_private.story_group_dissolutions(story_id,story_label,article_count,notes,reviewer) values(p_story,label,0,left(p_notes,2000),left(p_reviewer,200)) returning id into audit_id;
 for article in select distinct on(source_id,url) batch_key,rank,headline,source_id,url from public.story_assignments where story_id=p_story order by source_id,url,observed_at desc,batch_key desc,rank loop
  result:=public.newsboard_story_correct_article(article.batch_key,article.rank,null,article.headline,'Dissolved group: '||label,p_reviewer);
  replacements:=array_append(replacements,(result->>'target_story_id')::uuid);n:=n+1;
 end loop;
 if n=0 then raise exception 'Group has no article assignments';end if;
 update newsboard_private.story_group_dissolutions set article_count=n,replacement_story_ids=replacements where id=audit_id;
 return jsonb_build_object('story_id',p_story,'story_label',label,'articles_dissolved',n,'replacement_story_ids',replacements);
end $$;

create or replace function public.newsboard_story_auto_merge_suggestions(p_limit integer default 8,p_min_score numeric default 0.84) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare candidate record;merge_source_id uuid;merge_target_id uuid;used_ids uuid[]:=array[]::uuid[];merged_count integer:=0;failed_count integer:=0;failures jsonb:='[]'::jsonb;
begin
 if p_min_score<0.75 or p_min_score>1 then raise exception 'Auto-merge score must be between 0.75 and 1';end if;
 for candidate in select q.* from newsboard_private.story_match_suggestions q where q.status='pending' and q.score>=p_min_score
  and exists(select 1 from public.story_members m where m.story_id=q.story_a group by m.story_id having count(distinct m.source_id)=1)
  and exists(select 1 from public.story_members m where m.story_id=q.story_b group by m.story_id having count(distinct m.source_id)=1)
  order by q.score desc,q.last_scored_at desc limit least(25,greatest(1,p_limit)) for update skip locked loop
  if candidate.story_a=any(used_ids) or candidate.story_b=any(used_ids) then continue;end if;
  merge_source_id:=nullif(candidate.evidence->>'source_story_id','')::uuid;merge_target_id:=nullif(candidate.evidence->>'target_story_id','')::uuid;
  if merge_source_id is null or merge_target_id is null or not(merge_source_id in(candidate.story_a,candidate.story_b)) or not(merge_target_id in(candidate.story_a,candidate.story_b)) or merge_source_id=merge_target_id then continue;end if;
  begin
   perform public.newsboard_story_merge(merge_source_id,merge_target_id,'Automatic high-confidence matcher suggestion','story-intelligence-auto');
   update public.story_assignments set metadata=metadata-'manual_correction'-'manual_merge_source_story_id'-'manual_target_story_id'-'manual_reviewer'-'manual_corrected_at'||jsonb_build_object('automatic_suggestion_merge',true,'automatic_merge_source_story_id',merge_source_id,'automatic_target_story_id',merge_target_id,'automatic_matcher_version',candidate.matcher_version,'automatic_match_score',candidate.score,'automatic_merged_at',now()) where story_id=merge_target_id and metadata->>'manual_merge_source_story_id'=merge_source_id::text;
   insert into newsboard_private.story_match_decisions(story_a,story_b,decision,matcher_version,score,evidence,reviewer) values(merge_source_id,merge_target_id,'merge',candidate.matcher_version,candidate.score,candidate.evidence,'story-intelligence-auto');
   update newsboard_private.story_match_suggestions set status='merged',reviewed_at=now(),reviewer='story-intelligence-auto' where story_a=candidate.story_a and story_b=candidate.story_b;
   used_ids:=array_append(array_append(used_ids,merge_source_id),merge_target_id);merged_count:=merged_count+1;
  exception when others then failed_count:=failed_count+1;failures:=failures||jsonb_build_array(jsonb_build_object('story_a',candidate.story_a,'story_b',candidate.story_b,'error',left(sqlerrm,300)));end;
 end loop;
 return jsonb_build_object('merged',merged_count,'failed',failed_count,'minimum_score',p_min_score,'failures',failures);
end $$;

notify pgrst,'reload schema';
