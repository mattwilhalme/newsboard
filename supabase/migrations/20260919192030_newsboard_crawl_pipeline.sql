create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create table public.crawler_settings(id boolean primary key default true check(id),token_hash text not null);
alter table public.crawler_settings enable row level security;
revoke all on public.crawler_settings from public,anon,authenticated;
grant select on public.crawler_settings to service_role;
create table public.crawler_publishers(source_id text primary key references public.sources(id),method text not null check(method in ('http','browser')),reason text);
create table public.crawler_runs(id uuid primary key default gen_random_uuid(),started_at timestamptz not null default now(),completed_at timestamptz,trigger text not null check(trigger in ('supabase_cron','manual_edge_function','github_backup')),status text not null default 'running',publishers_attempted int not null default 0,publishers_succeeded int not null default 0,publishers_failed int not null default 0,duration_ms bigint,error_summary text);
create index crawler_runs_started_idx on public.crawler_runs(started_at desc);
create unique index crawler_one_active on public.crawler_runs((true)) where status='running';
create table public.crawler_source_runs(run_id uuid references public.crawler_runs(id) on delete cascade,source_id text references public.sources(id),started_at timestamptz not null,completed_at timestamptz not null,collection_method text not null,success boolean not null,item_count int not null default 0,duration_ms bigint not null,error text,http_status int,primary key(run_id,source_id));
create index crawler_source_health_idx on public.crawler_source_runs(source_id,completed_at desc);
create table public.crawler_current(source_id text primary key references public.sources(id),observed_at timestamptz not null,run_id uuid references public.crawler_runs(id),item jsonb not null,items jsonb not null,first_seen_at timestamptz not null,last_change_at timestamptz not null);
create index crawler_current_run_idx on public.crawler_current(run_id);
-- Generic ordered items support future multi-item collectors without raw HTML storage.
create table public.crawler_snapshots(id uuid primary key default gen_random_uuid(),run_id uuid references public.crawler_runs(id),source_id text references public.sources(id),observed_at timestamptz not null,items jsonb not null,unique(run_id,source_id));
create index crawler_snapshots_source_time_idx on public.crawler_snapshots(source_id,observed_at desc);
do $$ declare t text; begin
 foreach t in array array['crawler_publishers','crawler_runs','crawler_source_runs','crawler_current','crawler_snapshots'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select on public.%I to anon,authenticated',t);
 execute format('grant select,insert,update,delete on public.%I to service_role',t);
 execute format('create policy public_read on public.%I for select to anon,authenticated using(true)',t);
 end loop;
end $$;

create function public.newsboard_start_run(p_trigger text) returns uuid language plpgsql set search_path='' as $$
declare r uuid;
begin
 perform pg_advisory_xact_lock(794611);
 update public.crawler_runs set status='failed',completed_at=now(),error_summary='Run exceeded ten-minute lease; invocation interrupted',duration_ms=extract(epoch from(now()-started_at))*1000 where status='running' and started_at<now()-interval '10 minutes';
 if exists(select 1 from public.crawler_runs where status='running') then return null; end if;
 insert into public.crawler_runs(trigger) values(p_trigger) returning id into r;
 return r;
end $$;

create function public.newsboard_save_source(p jsonb) returns void language plpgsql set search_path='' as $$
declare sid text:=p->>'source_id'; rid uuid:=(p->>'run_id')::uuid; stamp timestamptz; previous public.crawler_current; output jsonb:=p->'output'; item jsonb:=p->'output'->'item'; succeeded boolean:=(p->>'success')::boolean;
begin
 perform 1 from public.crawler_runs where id=rid and status='running' for share;
 if not found then raise exception 'Run is not active'; end if;
 perform 1 from public.sources where id=sid for update;
 if exists(select 1 from public.crawler_source_runs where run_id=rid and source_id=sid) then return; end if;
 if succeeded then
  if coalesce(item->>'title','')='' or coalesce(item->>'url','')='' or coalesce(jsonb_array_length(output->'items'),0)=0 then raise exception 'Empty successful snapshot rejected'; end if;
  stamp:=(output->>'observed_at')::timestamptz;
  select * into previous from public.crawler_current where source_id=sid;
  insert into public.crawler_snapshots(run_id,source_id,observed_at,items) values(rid,sid,stamp,output->'items');
  insert into public.hero_runs(source_id,run_id,observed_at,title,url,img_url,ok,raw) values(sid,rid::text,stamp,item->>'title',item->>'url',item->>'imgUrl',true,jsonb_build_object('collection_method',p->>'method','content_type',item->>'contentType','run_kind','hero'));
  insert into public.headline_events(source_id,observed_at,slot_key,title,url,img_url,ok,raw) values(sid,stamp,'hero:1',item->>'title',item->>'url',item->>'imgUrl',true,jsonb_build_object('run_id',rid,'run_kind','hero','rank',1));
  insert into public.crawler_current(source_id,observed_at,run_id,item,items,first_seen_at,last_change_at)
  values(sid,stamp,rid,item,output->'items',case when previous.item->>'url'=item->>'url' then previous.first_seen_at else stamp end,case when previous.item->>'url'=item->>'url' and previous.item->>'title'=item->>'title' then previous.last_change_at else stamp end)
  on conflict(source_id) do update set observed_at=excluded.observed_at,run_id=excluded.run_id,item=excluded.item,items=excluded.items,first_seen_at=excluded.first_seen_at,last_change_at=excluded.last_change_at where excluded.observed_at>=crawler_current.observed_at;
 end if;
 insert into public.crawler_source_runs(run_id,source_id,started_at,completed_at,collection_method,success,item_count,duration_ms,error,http_status)
 values(rid,sid,(p->>'started_at')::timestamptz,(p->>'completed_at')::timestamptz,p->>'method',succeeded,case when succeeded then jsonb_array_length(output->'items') else 0 end,greatest(0,extract(epoch from((p->>'completed_at')::timestamptz-(p->>'started_at')::timestamptz))*1000),left(p->>'error',1000),(p->>'http_status')::int);
end $$;
create function public.newsboard_finish_run(p_run uuid,p_error text default null) returns void language sql set search_path='' as $$
 update public.crawler_runs set completed_at=now(),duration_ms=extract(epoch from(now()-started_at))*1000,publishers_attempted=s.n,publishers_succeeded=s.ok,publishers_failed=s.n-s.ok,status=case when p_error is not null or s.ok=0 then 'failed' when s.ok<s.n then 'partial' else 'success' end,error_summary=coalesce(p_error,s.errors)
 from(select count(*)::int n,count(*) filter(where success)::int ok,string_agg(source_id||': '||error,'; ') filter(where not success) errors from public.crawler_source_runs where run_id=p_run)s where id=p_run and status='running';
$$;
revoke all on function public.newsboard_start_run(text),public.newsboard_save_source(jsonb),public.newsboard_finish_run(uuid,text) from public,anon,authenticated;
grant execute on function public.newsboard_start_run(text),public.newsboard_save_source(jsonb),public.newsboard_finish_run(uuid,text) to service_role;

-- Seed current state only from known successful observations, not failed attempts.
insert into public.crawler_current(source_id,observed_at,item,items,first_seen_at,last_change_at)
select distinct on(source_id) source_id,observed_at,jsonb_build_object('title',title,'url',url,'imgUrl',img_url,'contentType',raw->>'content_type'),jsonb_build_array(jsonb_build_object('rank',1,'title',title,'url',url,'slot_key','hero:1')),observed_at,observed_at from public.hero_runs where ok and title is not null and url is not null order by source_id,observed_at desc;
insert into public.crawler_publishers(source_id,method,reason)
select id,'browser','Awaiting HTTP/browser equivalence validation' from public.sources where id in ('abc1','cbs1','usat1','nbc1','cnn1','guardian1','ap1','latimes1','npr1','bbc1','fox1','yahoo1');

create view public.v_crawler_health with(security_invoker=true) as
select p.source_id,p.method,p.reason,c.observed_at as last_success_at,extract(epoch from(now()-c.observed_at))::bigint as age_seconds,a.completed_at as last_attempt_at,a.success as last_attempt_success,a.error as latest_error,(select count(*) from public.crawler_source_runs r where r.source_id=p.source_id and not r.success and r.completed_at>coalesce((select max(completed_at) from public.crawler_source_runs s where s.source_id=p.source_id and s.success),'-infinity')) as consecutive_failures from public.crawler_publishers p left join public.crawler_current c using(source_id) left join lateral(select * from public.crawler_source_runs r where r.source_id=p.source_id order by completed_at desc limit 1)a on true;
grant select on public.v_crawler_health to anon,authenticated,service_role;

-- Generate the invocation secret inside Postgres; never expose it in migration output.
do $$ declare token text:=encode(extensions.gen_random_bytes(32),'hex'); begin
 perform vault.create_secret(token,'newsboard_crawl_token','Private Cron to Edge authentication');
 insert into public.crawler_settings(id,token_hash) values(true,encode(extensions.digest(token,'sha256'),'hex'));
end $$;
