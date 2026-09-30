-- A new identity preserves AP homepage history instead of relabeling it.
-- Version aligned with the applied Supabase Management API migration.
insert into public.sources(id,kind,name,home_url) values
 ('apgoogle1','discovery','AP via Google News','https://news.google.com/search?q=site%3Aapnews.com%20when%3A1d&hl=en-US&gl=US&ceid=US%3Aen');
insert into public.crawler_publishers(source_id,method,reason,browser_fallback_enabled)
 values('apgoogle1','http','Unranked AP article discovery via Google News RSS; not AP homepage tracking',false);
-- Remove only active routing configuration. All AP observations/history remain.
delete from public.crawler_publishers where source_id='ap1';
update public.crawler_browser_jobs set status='cancelled',completed_at=now(),deadline_at=null,next_retry_at=null,error='AP homepage collection retired; use AP via Google News discovery' where source_id='ap1';

create function public.newsboard_save_discovery(p jsonb) returns void language plpgsql security invoker set search_path='' as $$
declare sid text:=p->>'source_id'; rid uuid:=(p->>'run_id')::uuid; output jsonb:=p->'output'; rows jsonb:=output->'items'; item jsonb:=output->'item'; stamp timestamptz; previous public.crawler_current; succeeded boolean:=(p->>'success')::boolean; result text:=coalesce(p->>'outcome',case when (p->>'success')::boolean then 'success' else 'crawl_failed' end);
begin
 if succeeded is null or result not in ('success','blocked','crawl_failed','infrastructure_error') or succeeded<>(result='success') then raise exception 'Invalid discovery outcome'; end if;
 perform 1 from public.crawler_runs where id=rid and status='running' for share;
 if not found then raise exception 'Run is not active'; end if;
 perform 1 from public.sources where id=sid and kind='discovery' for update;
 if not found or sid<>'apgoogle1' then raise exception 'Unknown discovery source'; end if;
 if exists(select 1 from public.crawler_source_runs where run_id=rid and source_id=sid) then return; end if;
 if succeeded then
  if output->>'coverage_scope' is distinct from 'discovery' or output->>'source_id' is distinct from sid or p->>'method' is distinct from 'http'
   or output->>'feed_url' is distinct from 'https://news.google.com/rss/search?q=site%3Aapnews.com%20when%3A1d&hl=en-US&gl=US&ceid=US%3Aen'
   or jsonb_typeof(rows) is distinct from 'array' then raise exception 'Invalid discovery provenance'; end if;
  if jsonb_array_length(rows) not between 1 and 100 or item is distinct from rows->0
   or (output->'top10' is not null and output->'top10'<>'null'::jsonb) then raise exception 'Discovery must be nonempty and unranked'; end if;
  stamp:=(output->>'observed_at')::timestamptz;
  if stamp is null or stamp>now()+interval '5 minutes' or stamp<now()-interval '1 hour' then raise exception 'Invalid discovery observation time'; end if;
  if exists(select 1 from jsonb_array_elements(rows)x where jsonb_typeof(x)<>'object'
   or length(coalesce(x->>'title','')) not between 12 and 350
   or coalesce(x->>'url','') !~ '^https://news[.]google[.]com/(rss/)?articles/[A-Za-z0-9_-]+([?][^[:space:]]*)?$'
   or x ? 'rank' or x ? 'slot_key' or x ? 'slotKey'
   or x->>'coverageScope' is distinct from 'discovery' or x->>'via' is distinct from 'Google News' or x->>'publisher' is distinct from 'Associated Press'
   or x->>'publishedAt' is null or (x->>'publishedAt')::timestamptz<stamp-interval '48 hours' or (x->>'publishedAt')::timestamptz>stamp+interval '5 minutes') then raise exception 'Invalid discovery item'; end if;
  if exists(select 1 from jsonb_array_elements(rows) with ordinality as a(x,n) join jsonb_array_elements(rows) with ordinality as b(x,n) on b.n=a.n+1 where (a.x->>'publishedAt')::timestamptz<(b.x->>'publishedAt')::timestamptz) then raise exception 'Discoveries must be latest published first'; end if;
  select * into previous from public.crawler_current where source_id=sid;
  insert into public.crawler_snapshots(run_id,source_id,observed_at,items) values(rid,sid,stamp,rows);
  insert into public.crawler_current(source_id,observed_at,run_id,item,items,first_seen_at,last_change_at)
   values(sid,stamp,rid,item,rows,case when previous.item->>'url'=item->>'url' then previous.first_seen_at else stamp end,case when previous.item->>'url'=item->>'url' and previous.item->>'title'=item->>'title' then previous.last_change_at else stamp end)
   on conflict(source_id) do update set observed_at=excluded.observed_at,run_id=excluded.run_id,item=excluded.item,items=excluded.items,first_seen_at=excluded.first_seen_at,last_change_at=excluded.last_change_at where excluded.observed_at>=crawler_current.observed_at;
 end if;
 -- No hero_runs, headline_events, top10_runs, or rank events are emitted here.
 insert into public.crawler_source_runs(run_id,source_id,started_at,completed_at,collection_method,success,item_count,duration_ms,error,http_status,outcome)
  values(rid,sid,(p->>'started_at')::timestamptz,(p->>'completed_at')::timestamptz,p->>'method',succeeded,case when succeeded then jsonb_array_length(rows) else 0 end,greatest(0,extract(epoch from((p->>'completed_at')::timestamptz-(p->>'started_at')::timestamptz))*1000),left(p->>'error',1000),coalesce((p->>'http_status')::int,(output->>'http_status')::int),result);
end $$;

alter function public.newsboard_save_source(jsonb) rename to newsboard_save_homepage_source;
create function public.newsboard_save_source(p jsonb) returns void language plpgsql security invoker set search_path='' as $$
begin
 if exists(select 1 from public.sources where id=p->>'source_id' and kind='discovery') then
  perform public.newsboard_save_discovery(p);
 else perform public.newsboard_save_homepage_source(p);
 end if;
end $$;
revoke all on function public.newsboard_save_discovery(jsonb),public.newsboard_save_source(jsonb),public.newsboard_save_homepage_source(jsonb) from public,anon,authenticated;
grant execute on function public.newsboard_save_discovery(jsonb),public.newsboard_save_source(jsonb),public.newsboard_save_homepage_source(jsonb) to service_role;

-- Unranked discovery never enters homepage-based Story Identity intelligence.
create or replace view public.story_raw_batches with(security_invoker=true) as
select 'snapshot:'||s.id as batch_key,s.source_id,s.observed_at,
 case when t.id is not null then 'top10' else 'hero' end as scope,
 s.id as snapshot_id,t.id as top10_run_id,
 case when t.id is not null then (select jsonb_agg(jsonb_build_object('rank',i.rank,'title',i.title,'url',i.url,'fingerprint',i.fingerprint) order by i.rank) from public.top10_items i where i.run_id=t.id) else s.items end as items
from public.crawler_snapshots s
left join public.top10_runs t on t.crawler_run_id=s.run_id and t.source_id=s.source_id
left join public.crawler_source_runs r on r.run_id=s.run_id and r.source_id=s.source_id
where ((t.id is null and r.top10_status is null) or (t.ok and t.quality='complete'))
 and not exists(select 1 from public.sources src where src.id=s.source_id and src.kind='discovery')
union all
select 'top10:'||t.id,t.source_id,t.observed_at,'top10',null::uuid,t.id,
 coalesce((select jsonb_agg(jsonb_build_object('rank',i.rank,'title',i.title,'url',i.url,'fingerprint',i.fingerprint) order by i.rank) from public.top10_items i where i.run_id=t.id),'[]'::jsonb)
from public.top10_runs t where t.ok and t.quality='complete' and not exists(select 1 from public.crawler_snapshots s where s.run_id=t.crawler_run_id and s.source_id=t.source_id)
 and not exists(select 1 from public.sources src where src.id=t.source_id and src.kind='discovery');

create or replace function public.newsboard_snapshot() returns jsonb language sql stable security invoker set search_path='' as $$
select jsonb_build_object('cacheLike',jsonb_build_object('generatedAt',now(),'sources',coalesce((
 select jsonb_object_agg(p.source_id,jsonb_build_object(
 'ok',c.source_id is not null,'updatedAt',c.observed_at,'updated_at',c.observed_at,'firstSeenAt',c.first_seen_at,'lastChangeAt',c.last_change_at,'sourceName',s.name,'kind',s.kind,'homeUrl',s.home_url,'item',c.item,'items',case when s.kind='discovery' then c.items else null end,
 'health',jsonb_build_object(
 'crawlStatus',cs.crawl_status,'definitiveFailure',cs.crawl_status='failed',
 'lastAttemptSuccess',case when cs.crawl_status='success' then true when cs.crawl_status='failed' then false else null end,
 'lastSuccessfulCrawlAt',c.observed_at,'lastAttemptAt',cs.last_attempt_at,'lastFailureAt',cs.last_failure_at,'lastHeadlineChangeAt',c.last_change_at,
 'latestError',cs.error,'method',p.method,'browserFallbackAvailable',p.browser_fallback_enabled,
 'primaryAttempt',jsonb_build_object('status',cs.primary_status,'completedAt',cs.primary_attempt_at,'success',cs.primary_success,'error',cs.primary_error),
 'browserAttempt',jsonb_build_object('status',cs.browser_status,'requestedAt',cs.browser_requested_at,'startedAt',cs.browser_started_at,'completedAt',cs.browser_completed_at))))
 from public.crawler_publishers p join public.sources s on s.id=p.source_id
 left join public.crawler_current c on c.source_id=p.source_id left join public.v_crawler_attempt_status cs on cs.source_id=p.source_id
),'{}'::jsonb)),
'history',jsonb_build_object('generatedAt',now(),'sources',coalesce((select jsonb_object_agg(s.id,jsonb_build_object('entries',coalesce(h.entries,'[]'::jsonb))) from public.sources s left join lateral(select jsonb_agg(jsonb_build_object('title',x.title,'url',x.url,'firstSeenAt',x.first_seen,'lastSeenAt',x.last_seen,'seenCount',x.seen) order by x.last_seen) entries from(select title,url,min(observed_at) first_seen,max(observed_at) last_seen,count(*) seen from public.hero_runs where source_id=s.id and ok and url is not null group by title,url having max(observed_at)>now()-interval '7 days' or url=(select item->>'url' from public.crawler_current where source_id=s.id) order by max(observed_at) desc)x)h on true),'{}'::jsonb)));
$$;
