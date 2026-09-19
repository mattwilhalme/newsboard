create or replace function public.newsboard_save_source(p jsonb) returns void language plpgsql set search_path='' as $$
declare tid uuid; previous uuid; sid text:=p->>'source_id'; stamp timestamptz:=(p->'output'->>'observed_at')::timestamptz; rows jsonb:=p->'output'->'top10';
begin
 perform 1 from public.sources where id=sid for update;
 if exists(select 1 from public.crawler_source_runs where run_id=(p->>'run_id')::uuid and source_id=sid) then return; end if;
 if (p->>'success')::boolean and rows is not null and rows<>'null'::jsonb and jsonb_array_length(rows)<>10 then raise exception 'Incomplete Top 10 snapshot'; end if;
 perform public.newsboard_save_source_base(p);
 if not (p->>'success')::boolean or rows is null or rows='null'::jsonb then return; end if;
 select id into previous from public.top10_runs where source_id=sid and ok and observed_at<stamp order by observed_at desc limit 1;
 insert into public.top10_runs(source_id,observed_at,ok,crawler_run_id) values(sid,stamp,true,(p->>'run_id')::uuid) on conflict(crawler_run_id,source_id) do nothing returning id into tid;
 if tid is null then return; end if;
 insert into public.top10_items(run_id,source_id,rank,title,url,fingerprint,related_links)
 select tid,sid,(x->>'rank')::int,x->>'title',x->>'url',x->>'fingerprint',coalesce(x->'related_links','[]') from jsonb_array_elements(rows)x;
 -- Preserve the existing fingerprint-based event semantics.
 insert into public.top10_events(source_id,observed_at,event_type,fingerprint,from_rank,to_rank,from_title,to_title,from_run_id,to_run_id)
 select sid,stamp,'ENTERED_TOP10',n.fingerprint,null,n.rank,null,n.title,previous,tid from public.top10_items n where n.run_id=tid and not exists(select 1 from public.top10_items o where o.run_id=previous and o.fingerprint=n.fingerprint)
 union all select sid,stamp,'EXITED_TOP10',o.fingerprint,o.rank,null,o.title,null,previous,tid from public.top10_items o where o.run_id=previous and not exists(select 1 from public.top10_items n where n.run_id=tid and n.fingerprint=o.fingerprint)
 union all select sid,stamp,'MOVED',n.fingerprint,o.rank,n.rank,o.title,n.title,previous,tid from public.top10_items n join public.top10_items o on o.run_id=previous and o.fingerprint=n.fingerprint where n.run_id=tid and n.rank<>o.rank
 union all select sid,stamp,'TITLE_UPDATED',n.fingerprint,o.rank,n.rank,o.title,n.title,previous,tid from public.top10_items n join public.top10_items o on o.run_id=previous and o.fingerprint=n.fingerprint where n.run_id=tid and n.title is distinct from o.title;
 insert into public.headline_events(source_id,observed_at,slot_key,title,url,ok,raw)
 select sid,stamp,'top10:'||rank,title,url,true,jsonb_build_object('run_id',p->>'run_id','run_kind','top10','rank',rank,'fingerprint',fingerprint) from public.top10_items where run_id=tid;
end $$;

create or replace function public.newsboard_snapshot() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object('cacheLike',jsonb_build_object('generatedAt',now(),'sources',coalesce((select jsonb_object_agg(c.source_id,jsonb_build_object('ok',true,'updatedAt',c.observed_at,'updated_at',c.observed_at,'firstSeenAt',c.first_seen_at,'lastChangeAt',c.last_change_at,'sourceName',s.name,'item',c.item,'health',jsonb_build_object('lastAttemptAt',h.last_attempt_at,'lastAttemptSuccess',h.last_attempt_success,'latestError',h.latest_error,'consecutiveFailures',h.consecutive_failures,'method',h.method))) from public.crawler_current c join public.sources s on s.id=c.source_id left join public.v_crawler_health h on h.source_id=c.source_id),'{}'::jsonb)),
'history',jsonb_build_object('generatedAt',now(),'sources',coalesce((select jsonb_object_agg(s.id,jsonb_build_object('entries',coalesce(h.entries,'[]'::jsonb))) from public.sources s left join lateral(select jsonb_agg(jsonb_build_object('title',x.title,'url',x.url,'firstSeenAt',x.first_seen,'lastSeenAt',x.last_seen,'seenCount',x.seen) order by x.last_seen) entries from(select title,url,min(observed_at) first_seen,max(observed_at) last_seen,count(*) seen from public.hero_runs where source_id=s.id and ok and url is not null group by title,url having max(observed_at)>now()-interval '7 days' or url=(select item->>'url' from public.crawler_current where source_id=s.id) order by max(observed_at) desc)x)h on true),'{}'::jsonb)));
$$;
