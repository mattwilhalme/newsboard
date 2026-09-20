-- Preserve existing event rows on unchanged observations; only reconcile changed chronology.
create or replace function public.newsboard_story_rebuild(p_story uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare origin public.story_assignments;
begin
 select * into strict origin from public.story_assignments where story_id=p_story order by observed_at,source_id,batch_key,rank limit 1;
 insert into public.story_members(story_id,source_id,fingerprint,url,first_headline,latest_headline,first_seen_at,last_seen_at,first_rank,peak_rank,current_rank,first_number_one_at,active,coverage_scope,match_metadata)
 select p_story,g.source_id,last_a.fingerprint,last_a.url,first_a.headline,last_a.headline,g.first_seen,g.last_seen,
 first_a.rank,g.peak,case when last_b.batch_key=last_a.batch_key then last_a.rank else null end,g.first_one,
 last_b.batch_key=last_a.batch_key,last_b.scope,first_a.metadata
 from (select source_id,min(observed_at) first_seen,max(observed_at) last_seen,min(rank) peak,min(observed_at) filter(where rank=1) first_one from public.story_assignments where story_id=p_story group by source_id)g
 cross join lateral(select a.* from public.story_assignments a where a.story_id=p_story and a.source_id=g.source_id order by observed_at,batch_key,rank limit 1)first_a
 cross join lateral(select a.* from public.story_assignments a where a.story_id=p_story and a.source_id=g.source_id order by observed_at desc,batch_key desc,rank limit 1)last_a
 cross join lateral(select b.* from public.story_processed_batches b where b.source_id=g.source_id order by observed_at desc,batch_key desc limit 1)last_b
 on conflict(story_id,source_id) do update set fingerprint=excluded.fingerprint,url=excluded.url,first_headline=excluded.first_headline,latest_headline=excluded.latest_headline,
 first_seen_at=excluded.first_seen_at,last_seen_at=excluded.last_seen_at,first_rank=excluded.first_rank,peak_rank=excluded.peak_rank,current_rank=excluded.current_rank,
 first_number_one_at=excluded.first_number_one_at,active=excluded.active,coverage_scope=excluded.coverage_scope,match_metadata=excluded.match_metadata,updated_at=now();
 update public.stories set canonical_label=origin.headline,first_detected_at=origin.observed_at,first_source_id=origin.source_id,
 last_seen_at=(select max(last_seen_at) from public.story_members where story_id=p_story),active=exists(select 1 from public.story_members where story_id=p_story and active),
 search_terms=array(select distinct t from public.story_assignments a cross join lateral unnest(a.terms)t where a.story_id=p_story order by t limit 200),updated_at=now() where id=p_story;
 with rows as (
 select b.*,a.headline,a.headline_norm,a.url,a.rank,a.published_at,a.metadata,
 row_number() over(partition by b.source_id order by b.observed_at,b.batch_key) as n,
 lag(a.rank) over w as prev_rank,lag(a.headline) over w as prev_headline,lag(a.headline_norm) over w as prev_norm,lag(a.url) over w as prev_url,lag(b.scope) over w as prev_scope
 from public.story_members m join public.story_processed_batches b on b.source_id=m.source_id and b.observed_at>=m.first_seen_at
 left join lateral(select x.* from public.story_assignments x where x.batch_key=b.batch_key and x.story_id=p_story order by rank limit 1)a on true
 where m.story_id=p_story window w as(partition by b.source_id order by b.observed_at,b.batch_key)
 ), events as (
 select r.*,e.kind from rows r cross join lateral (values
 ('FIRST_DETECTED',r.n=1 and r.source_id=origin.source_id),
 ('PUBLISHER_PICKUP',r.n=1 and r.source_id<>origin.source_id),
 ('ENTERED_TOP10',r.rank is not null and r.prev_rank is null and r.scope='top10'),
 ('RETURNED_TO_LEAD',r.rank is not null and r.prev_rank is null and r.scope='hero' and r.n>1),
 ('REACHED_NUMBER_ONE',r.rank=1 and r.prev_rank is distinct from 1),
 ('RANK_CHANGED',r.rank is not null and r.prev_rank is not null and r.rank<>r.prev_rank),
 ('HEADLINE_CHANGED',r.rank is not null and r.prev_rank is not null and r.headline_norm is distinct from r.prev_norm),
 ('URL_CHANGED',r.rank is not null and r.prev_rank is not null and r.url is distinct from r.prev_url),
 ('EXITED_TOP10',r.rank is null and r.prev_rank is not null and r.prev_scope='top10'),
 ('LEFT_HOMEPAGE_LEAD',r.rank is null and r.prev_rank is not null and r.prev_scope='hero')
 )e(kind,yes) where e.yes
 ), desired as (select md5(p_story::text||source_id||batch_key||kind)::uuid as id,p_story as story_id,source_id,observed_at,coalesce(headline,prev_headline) as headline,coalesce(url,prev_url) as url,rank,kind as event_type,top10_run_id,published_at,
 jsonb_build_object('batch_key',batch_key,'coverage_scope',scope,'from_rank',prev_rank,'to_rank',rank,'old_headline',prev_headline,'new_headline',headline,'old_url',prev_url,'match',coalesce(metadata,'{}'::jsonb)) as metadata from events
 ), pruned as (
 delete from public.story_observations o where o.story_id=p_story and not exists(select 1 from desired d where d.id=o.id)
 )
 insert into public.story_observations(id,story_id,source_id,observed_at,headline,url,rank,event_type,top10_run_id,published_at,metadata)
 select id,story_id,source_id,observed_at,headline,url,rank,event_type,top10_run_id,published_at,metadata from desired
 on conflict(id) do update set headline=excluded.headline,url=excluded.url,rank=excluded.rank,published_at=excluded.published_at,metadata=excluded.metadata
 where (public.story_observations.headline,public.story_observations.url,public.story_observations.rank,public.story_observations.published_at,public.story_observations.metadata)
 is distinct from (excluded.headline,excluded.url,excluded.rank,excluded.published_at,excluded.metadata);
end $$;
