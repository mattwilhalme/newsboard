-- Keep historical ABC data; quality defaults describe its existing complete runs.
alter table public.top10_runs add column quality text not null default 'complete' check(quality in ('complete','partial','warning','failed'));
alter table public.top10_runs add column item_count int not null default 10 check(item_count between 0 and 10);
alter table public.top10_runs add column diagnostics jsonb not null default '{}';
alter table public.crawler_source_runs add column top10_status text;
alter table public.crawler_source_runs add column top10_error text;

create function public.newsboard_article_key(u text) returns text language plpgsql immutable set search_path='' as $$
declare base text; query text; args text;
begin
 base:=split_part(split_part(u,'#',1),'?',1);
 base:=regexp_replace(base,'^http://','https://','i');
 base:=regexp_replace(base,'^(https://)www\.','\1','i');
 base:=regexp_replace(base,'^https://abcnews\.com/','https://abcnews.go.com/','i');
 base:=regexp_replace(base,'^https://news\.yahoo\.com/','https://yahoo.com/','i');
 base:=regexp_replace(base,'/+$','');
 query:=split_part(split_part(u,'#',1),'?',2);
 select string_agg(v,'&' order by v) into args from unnest(string_to_array(query,'&')) v
 where v<>'' and split_part(v,'=',1)!~* '^(utm_|fbclid$|gclid$|dclid$|ocid$|ncid$|guccounter$|guce_|cmpid$|cid$|cvid$|ref$|ref_src$|mod$|output$|smid$|_ga$|_gl$|mc_|entryId$)';
 return base||case when args is null then '' else '?'||args end;
end $$;

create function public.newsboard_save_top10(p jsonb) returns void language plpgsql set search_path='' as $$
declare tid uuid; previous uuid; sid text:=p->>'source_id'; rid uuid:=(p->>'run_id')::uuid;
 stamp timestamptz:=(p->'output'->>'observed_at')::timestamptz; rows jsonb:=p->'output'->'top10';
 n int; q text; diag jsonb:=coalesce(p->'output'->'top10_diagnostics','{}'::jsonb);
begin
 if not exists(select 1 from public.crawler_source_runs where run_id=rid and source_id=sid and success) then raise exception 'Successful raw crawl required'; end if;
 n:=jsonb_array_length(rows);
 if n>10 or n is null then raise exception 'Invalid ranked array'; end if;
 if exists(select 1 from jsonb_array_elements(rows) with ordinality as x(v,i)
 where (v->>'rank')::int is distinct from i or length(trim(coalesce(v->>'title','')))<12 or coalesce(v->>'url','')!~'^https?://' or coalesce(v->>'fingerprint','')='') then raise exception 'Invalid ranked item'; end if;
 if (select count(distinct public.newsboard_article_key(v->>'url')) from jsonb_array_elements(rows)v)<>n then raise exception 'Duplicate article URL'; end if;
 q:=case when n=0 then 'failed' when p->'output'->>'top10_quality' in ('warning','failed') then p->'output'->>'top10_quality'
 when n<10 then 'partial' when public.newsboard_article_key(rows->0->>'url')<>public.newsboard_article_key(p->'output'->'item'->>'url') then 'warning' else 'complete' end;
 insert into public.top10_runs(source_id,observed_at,ok,crawler_run_id,quality,item_count,diagnostics,error)
 values(sid,stamp,n>0 and q<>'failed',rid,q,n,diag,case when q='failed' then coalesce(diag->>'error','No valid ranked stories') end)
 on conflict(crawler_run_id,source_id) do nothing returning id into tid;
 if tid is null then return; end if;
 insert into public.top10_items(run_id,source_id,rank,title,url,fingerprint,related_links)
 select tid,sid,(v->>'rank')::int,v->>'title',public.newsboard_article_key(v->>'url'),v->>'fingerprint',coalesce(v->'related_links','[]') from jsonb_array_elements(rows)v;
 update public.crawler_source_runs set top10_status=q,top10_error=case when q='failed' then coalesce(diag->>'error','No valid ranked stories') end where run_id=rid and source_id=sid;
 -- Partial/warning results are useful diagnostics, never evidence of rank or exit.
 if q<>'complete' then return; end if;
 select id into previous from public.top10_runs where source_id=sid and ok and quality='complete' and observed_at<stamp order by observed_at desc limit 1;
 insert into public.top10_events(source_id,observed_at,event_type,fingerprint,from_rank,to_rank,from_title,to_title,from_run_id,to_run_id)
 select sid,stamp,'ENTERED_TOP10',n.fingerprint,null,n.rank,null,n.title,previous,tid from public.top10_items n where n.run_id=tid and not exists(select 1 from public.top10_items o where o.run_id=previous and public.newsboard_article_key(o.url)=n.url)
 union all select sid,stamp,'EXITED_TOP10',o.fingerprint,o.rank,null,o.title,null,previous,tid from public.top10_items o where o.run_id=previous and not exists(select 1 from public.top10_items n where n.run_id=tid and n.url=public.newsboard_article_key(o.url))
 union all select sid,stamp,'MOVED',n.fingerprint,o.rank,n.rank,o.title,n.title,previous,tid from public.top10_items n join public.top10_items o on o.run_id=previous and public.newsboard_article_key(o.url)=n.url where n.run_id=tid and n.rank<>o.rank
 union all select sid,stamp,'TITLE_UPDATED',n.fingerprint,o.rank,n.rank,o.title,n.title,previous,tid from public.top10_items n join public.top10_items o on o.run_id=previous and public.newsboard_article_key(o.url)=n.url where n.run_id=tid and n.title is distinct from o.title;
 insert into public.headline_events(source_id,observed_at,slot_key,title,url,ok,raw)
 select sid,stamp,'top10:'||rank,title,url,true,jsonb_build_object('run_id',rid,'run_kind','top10','rank',rank,'fingerprint',fingerprint) from public.top10_items where run_id=tid;
end $$;

create or replace function public.newsboard_save_source(p jsonb) returns void language plpgsql set search_path='' as $$
declare raw jsonb:=p; sid text:=p->>'source_id'; rid uuid:=(p->>'run_id')::uuid; msg text;
begin
 perform 1 from public.sources where id=sid for update;
 if exists(select 1 from public.crawler_source_runs where run_id=rid and source_id=sid) then return; end if;
 -- The raw snapshot always survives an invalid/missing Top 10. It contains CP,
 -- while the Story Identity view below obtains ranked items from top10_items.
 if (p->>'success')::boolean then
  raw:=jsonb_set(p,'{output,items}',jsonb_build_array((p->'output'->'item')||jsonb_build_object('rank',1,'slot_key','hero:1')));
 end if;
 perform public.newsboard_save_source_base(raw);
 if not (p->>'success')::boolean or p->'output'->'top10' is null or p->'output'->'top10'='null'::jsonb then return; end if;
 begin
  perform public.newsboard_save_top10(p);
 exception when others then
  get stacked diagnostics msg=message_text;
  update public.crawler_source_runs set top10_status='failed',top10_error=left(msg,500) where run_id=rid and source_id=sid;
 end;
end $$;
revoke all on function public.newsboard_save_top10(jsonb),public.newsboard_article_key(text) from public,anon,authenticated;
grant execute on function public.newsboard_save_top10(jsonb),public.newsboard_article_key(text) to service_role;

-- Preserve batch keys/ledger. Only complete ranked observations enter derived
-- intelligence; don't interpret a partial/failed extraction as nine exits.
create or replace view public.story_raw_batches with(security_invoker=true) as
select 'snapshot:'||s.id as batch_key,s.source_id,s.observed_at,
 case when t.id is not null then 'top10' else 'hero' end as scope,
 s.id as snapshot_id,t.id as top10_run_id,
 case when t.id is not null then (select jsonb_agg(jsonb_build_object('rank',i.rank,'title',i.title,'url',i.url,'fingerprint',i.fingerprint) order by i.rank) from public.top10_items i where i.run_id=t.id) else s.items end as items
from public.crawler_snapshots s
left join public.top10_runs t on t.crawler_run_id=s.run_id and t.source_id=s.source_id
left join public.crawler_source_runs r on r.run_id=s.run_id and r.source_id=s.source_id
where (t.id is null and r.top10_status is null) or (t.ok and t.quality='complete')
union all
select 'top10:'||t.id,t.source_id,t.observed_at,'top10',null::uuid,t.id,
 coalesce((select jsonb_agg(jsonb_build_object('rank',i.rank,'title',i.title,'url',i.url,'fingerprint',i.fingerprint) order by i.rank) from public.top10_items i where i.run_id=t.id),'[]'::jsonb)
from public.top10_runs t where t.ok and t.quality='complete' and not exists(select 1 from public.crawler_snapshots s where s.run_id=t.crawler_run_id and s.source_id=t.source_id);
