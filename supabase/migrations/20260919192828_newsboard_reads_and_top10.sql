alter table public.top10_runs add column crawler_run_id uuid references public.crawler_runs(id);
create unique index top10_runs_crawler_unique on public.top10_runs(crawler_run_id,source_id);
alter table public.top10_items add column related_links jsonb not null default '[]';
alter function public.newsboard_save_source(jsonb) rename to newsboard_save_source_base;
create function public.newsboard_save_source(p jsonb) returns void language plpgsql set search_path='' as $$
declare tid uuid; previous uuid; sid text:=p->>'source_id'; stamp timestamptz:=(p->'output'->>'observed_at')::timestamptz; rows jsonb:=p->'output'->'top10';
begin
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
revoke all on function public.newsboard_save_source(jsonb) from public,anon,authenticated;
grant execute on function public.newsboard_save_source(jsonb) to service_role;
do $$ declare t text; begin foreach t in array array['top10_runs','top10_items','top10_events'] loop
 execute format('grant select on public.%I to anon,authenticated',t);
 execute format('create policy public_read on public.%I for select to anon,authenticated using(true)',t);
end loop; end $$;

create function public.newsboard_snapshot() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object('cacheLike',jsonb_build_object('generatedAt',now(),'sources',coalesce((select jsonb_object_agg(c.source_id,jsonb_build_object('ok',true,'updatedAt',c.observed_at,'updated_at',c.observed_at,'firstSeenAt',c.first_seen_at,'lastChangeAt',c.last_change_at,'sourceName',s.name,'item',c.item,'health',jsonb_build_object('lastAttemptAt',h.last_attempt_at,'lastAttemptSuccess',h.last_attempt_success,'latestError',h.latest_error,'consecutiveFailures',h.consecutive_failures,'method',h.method))) from public.crawler_current c join public.sources s on s.id=c.source_id left join public.v_crawler_health h on h.source_id=c.source_id),'{}'::jsonb)),
'history',jsonb_build_object('generatedAt',now(),'sources',coalesce((select jsonb_object_agg(s.id,jsonb_build_object('entries',coalesce(h.entries,'[]'::jsonb))) from public.sources s left join lateral(select jsonb_agg(jsonb_build_object('title',x.title,'url',x.url,'firstSeenAt',x.first_seen,'lastSeenAt',x.last_seen,'seenCount',x.seen) order by x.last_seen) entries from(select title,url,min(observed_at) first_seen,max(observed_at) last_seen,count(*) seen from public.hero_runs where source_id=s.id and ok and url is not null group by title,url order by max(observed_at) desc limit 200)x)h on true),'{}'::jsonb)));
$$;
grant execute on function public.newsboard_snapshot() to anon,authenticated,service_role;

create function public.newsboard_timeline(p_hours int default 12) returns jsonb language sql stable set search_path='' as $$
with rows as(select * from public.hero_runs where ok and observed_at>now()-make_interval(hours=>least(168,greatest(1,p_hours))) order by observed_at desc limit 5000), typed as(select *,lag(url) over(partition by source_id order by observed_at,id) prev_url,lag(title) over(partition by source_id order by observed_at,id) prev_title from rows)
select jsonb_build_object('ok',true,'generatedAt',now(),'events',coalesce(jsonb_agg(jsonb_build_object('ts',observed_at,'observed_at',observed_at,'source_id',source_id,'title',title,'url',url,'kind',case when url is distinct from prev_url then 'new_url' when title is distinct from prev_title then 'new_headline' else 'heartbeat' end) order by observed_at desc),'[]'::jsonb)) from typed;
$$;
grant execute on function public.newsboard_timeline(int) to anon,authenticated,service_role;

create function public.newsboard_top10(p_hours int default 168) returns jsonb language sql stable set search_path='' as $$
with runs as(select r.id,r.observed_at,jsonb_build_object('ok',r.ok,'source_id',r.source_id,'observedAt',r.observed_at,'runId',r.id,'items',coalesce((select jsonb_agg(jsonb_build_object('rank',i.rank,'title',i.title,'url',i.url,'fingerprint',i.fingerprint,'related_links',i.related_links) order by i.rank) from public.top10_items i where i.run_id=r.id),'[]'::jsonb)) payload from public.top10_runs r where r.source_id='abc1' and r.ok order by r.observed_at desc limit 2016)
select jsonb_build_object('latest',(select payload from runs order by observed_at desc limit 1),'runs',coalesce((select jsonb_agg(payload order by observed_at) from runs where observed_at>now()-make_interval(hours=>least(168,greatest(1,p_hours)))),'[]'::jsonb),'events',coalesce((select jsonb_agg(e order by e.observed_at) from(select * from public.top10_events where source_id='abc1' and observed_at>now()-make_interval(hours=>least(168,greatest(1,p_hours))) order by observed_at desc limit 3000)e),'[]'::jsonb));
$$;
grant execute on function public.newsboard_top10(int) to anon,authenticated,service_role;
