-- Derived intelligence only. No triggers or changes to raw crawler write functions.
create table public.stories (
 id uuid primary key default gen_random_uuid(), canonical_label text not null,
 first_detected_at timestamptz not null, first_source_id text not null references public.sources(id),
 last_seen_at timestamptz not null, active boolean not null default true,
 search_terms text[] not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index stories_recent_idx on public.stories(last_seen_at desc);
create index stories_first_idx on public.stories(first_detected_at);
create index stories_first_source_idx on public.stories(first_source_id);
create index stories_terms_idx on public.stories using gin(search_terms);
create table public.story_members (
 id uuid primary key default gen_random_uuid(), story_id uuid not null references public.stories(id) on delete cascade,
 source_id text not null references public.sources(id), fingerprint text, url text not null,
 first_headline text not null, latest_headline text not null,
 first_seen_at timestamptz not null, last_seen_at timestamptz not null,
 first_rank integer, peak_rank integer, current_rank integer, first_number_one_at timestamptz,
 active boolean not null, coverage_scope text not null check(coverage_scope in ('hero','top10')),
 match_metadata jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(story_id,source_id)
);
create index story_members_source_url_idx on public.story_members(source_id,url);
create index story_members_seen_idx on public.story_members(last_seen_at desc);
create table public.story_processed_batches (
 batch_key text primary key, source_id text not null references public.sources(id), observed_at timestamptz not null,
 scope text not null check(scope in ('hero','top10')),
 snapshot_id uuid references public.crawler_snapshots(id) on delete set null,
 top10_run_id uuid references public.top10_runs(id) on delete set null, processed_at timestamptz not null default now()
);
create index story_batches_source_time_idx on public.story_processed_batches(source_id,observed_at,batch_key);
create index story_batches_snapshot_idx on public.story_processed_batches(snapshot_id);
create index story_batches_top10_idx on public.story_processed_batches(top10_run_id);
create table public.story_assignments (
 batch_key text not null references public.story_processed_batches(batch_key) on delete cascade,
 rank integer not null check(rank between 1 and 10), story_id uuid not null references public.stories(id) on delete cascade,
 source_id text not null references public.sources(id), observed_at timestamptz not null,
 headline text not null, headline_norm text not null, url text not null, fingerprint text,
 published_at timestamptz, terms text[] not null default '{}', metadata jsonb not null default '{}',
 primary key(batch_key,rank)
);
create index story_assignments_story_time_idx on public.story_assignments(story_id,source_id,observed_at);
create index story_assignments_source_url_idx on public.story_assignments(source_id,url,observed_at desc);
create table public.story_observations (
 id uuid primary key, story_id uuid not null references public.stories(id) on delete cascade,
 source_id text not null references public.sources(id), observed_at timestamptz not null,
 headline text, url text, rank integer, event_type text not null check(event_type in
 ('FIRST_DETECTED','PUBLISHER_PICKUP','ENTERED_TOP10','RANK_CHANGED','REACHED_NUMBER_ONE','HEADLINE_CHANGED','URL_CHANGED','EXITED_TOP10','LEFT_HOMEPAGE_LEAD','RETURNED_TO_LEAD')),
 top10_run_id uuid references public.top10_runs(id) on delete set null,
 published_at timestamptz, metadata jsonb not null default '{}', created_at timestamptz not null default now()
);
create index story_observations_timeline_idx on public.story_observations(story_id,observed_at,id);
create index story_observations_source_idx on public.story_observations(source_id,observed_at);
create index story_observations_top10_idx on public.story_observations(top10_run_id);
create table public.story_processing_runs (
 id uuid primary key default gen_random_uuid(), started_at timestamptz not null default now(), completed_at timestamptz,
 window_start timestamptz not null, window_end timestamptz not null, mode text not null,
 status text not null default 'running', batches_processed integer not null default 0, error text
);
create index story_processing_runs_started_idx on public.story_processing_runs(started_at desc);
create table public.story_worker_state (
 id boolean primary key default true check(id), history_start timestamptz not null default now(),
 lock_owner uuid, lock_until timestamptz
);
insert into public.story_worker_state(id) values(true);
create index if not exists crawler_snapshots_observed_idx on public.crawler_snapshots(observed_at,id);
create index if not exists top10_runs_observed_idx on public.top10_runs(observed_at,id) where ok;

-- Successful snapshots cover both Top 10 and hero-only publishers. Legacy Top 10
-- runs without a crawler snapshot are included once, never duplicated.
create view public.story_raw_batches with (security_invoker=true) as
select 'snapshot:'||s.id as batch_key,s.source_id,s.observed_at,
 case when t.id is not null then 'top10' else 'hero' end as scope,
 s.id as snapshot_id,t.id as top10_run_id,s.items
from public.crawler_snapshots s left join public.top10_runs t on t.crawler_run_id=s.run_id and t.source_id=s.source_id and t.ok
union all
select 'top10:'||t.id,t.source_id,t.observed_at,'top10',null::uuid,t.id,
 coalesce((select jsonb_agg(jsonb_build_object('rank',i.rank,'title',i.title,'url',i.url,'fingerprint',i.fingerprint) order by i.rank) from public.top10_items i where i.run_id=t.id),'[]'::jsonb)
from public.top10_runs t where t.ok and not exists(select 1 from public.crawler_snapshots s where s.run_id=t.crawler_run_id and s.source_id=t.source_id);

create function public.newsboard_story_begin(p_start timestamptz default null,p_end timestamptz default null)
returns uuid language plpgsql security invoker set search_path='' as $$
declare r uuid; st public.story_worker_state; a timestamptz; z timestamptz;
begin
 select * into st from public.story_worker_state where id for update;
 if st.lock_until>now() then return null; end if;
 a:=coalesce(p_start,st.history_start); z:=coalesce(p_end,now());
 if a>=z or (p_start is not null and z-a>interval '24 hours') or z>now()+interval '1 minute' then raise exception 'Specify an ordered backfill window of at most 24 hours'; end if;
 update public.story_processing_runs set status='interrupted',completed_at=now(),error='Worker lease expired' where status='running';
 insert into public.story_processing_runs(window_start,window_end,mode) values(a,z,case when p_start is null then 'live' else 'backfill' end) returning id into r;
 update public.story_worker_state set lock_owner=r,lock_until=now()+interval '3 minutes' where id;
 return r;
end $$;
create function public.newsboard_story_inputs(p_run uuid,p_limit integer default 60)
returns setof public.story_raw_batches language sql security invoker set search_path='' as $$
 select b.* from public.story_raw_batches b join public.story_processing_runs r on r.id=p_run
 where b.observed_at>=r.window_start and b.observed_at<r.window_end
 and not exists(select 1 from public.story_processed_batches done where done.batch_key=b.batch_key)
 order by b.observed_at,b.batch_key limit least(120,greatest(1,p_limit));
$$;
create function public.newsboard_story_candidates(p_terms text[],p_at timestamptz,p_source text,p_urls text[])
returns jsonb language sql security invoker set search_path='' as $$
 with candidates as (
 select s.* from public.stories s
 where s.last_seen_at>=p_at-interval '48 hours' and s.first_detected_at<=p_at+interval '48 hours'
 and (s.search_terms && p_terms or exists(select 1 from public.story_assignments a where a.story_id=s.id and a.source_id=p_source and a.url=any(p_urls) and a.observed_at between p_at-interval '48 hours' and p_at+interval '48 hours'))
 order by (select count(*) from unnest(s.search_terms) t where t=any(p_terms)) desc,s.last_seen_at desc limit 100
 ) select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'first_detected_at',s.first_detected_at,'last_seen_at',s.last_seen_at,
 'representatives',coalesce((select jsonb_agg(x) from (
 select distinct on (a.source_id,a.headline,a.url) a.source_id,a.headline as title,a.url,a.observed_at from public.story_assignments a
 where a.story_id=s.id and a.observed_at between p_at-interval '48 hours' and p_at+interval '48 hours'
 order by a.source_id,a.headline,a.url,abs(extract(epoch from(a.observed_at-p_at))) limit 24)x),'[]'::jsonb))),'[]'::jsonb) from candidates s;
$$;

-- Reconstruct meaningful chronology from immutable batch assignments. This also
-- handles older, explicitly bounded backfills without regressing latest state.
create function public.newsboard_story_rebuild(p_story uuid) returns void
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
 delete from public.story_observations where story_id=p_story;
 insert into public.story_observations(id,story_id,source_id,observed_at,headline,url,rank,event_type,top10_run_id,published_at,metadata)
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
 ) select md5(p_story::text||source_id||batch_key||kind)::uuid,p_story,source_id,observed_at,coalesce(headline,prev_headline),coalesce(url,prev_url),rank,kind,top10_run_id,published_at,
 jsonb_build_object('batch_key',batch_key,'coverage_scope',scope,'from_rank',prev_rank,'to_rank',rank,'old_headline',prev_headline,'new_headline',headline,'old_url',prev_url,'match',coalesce(metadata,'{}'::jsonb)) from events;
end $$;

create function public.newsboard_story_commit(p_run uuid,p_batch_key text,p_assignments jsonb) returns boolean
language plpgsql security invoker set search_path='' as $$
declare b public.story_raw_batches; x jsonb; sid uuid; affected uuid[]:='{}'; st uuid;
begin
 -- Serializes derived writes only. It never locks a raw crawler row.
 perform pg_advisory_xact_lock(794612);
 if not exists(select 1 from public.story_worker_state where id and lock_owner=p_run and lock_until>now()) then raise exception 'Story worker lease lost'; end if;
 if exists(select 1 from public.story_processed_batches where batch_key=p_batch_key) then return false; end if;
 select * into strict b from public.story_raw_batches where batch_key=p_batch_key;
 if jsonb_array_length(p_assignments)<>jsonb_array_length(b.items) or jsonb_array_length(p_assignments)=0 then raise exception 'Incomplete story assignments'; end if;
 select coalesce(array_agg(story_id),'{}') into affected from public.story_members where source_id=b.source_id and (active or last_seen_at>=b.observed_at);
 insert into public.story_processed_batches(batch_key,source_id,observed_at,scope,snapshot_id,top10_run_id) values(b.batch_key,b.source_id,b.observed_at,b.scope,b.snapshot_id,b.top10_run_id);
 for x in select value from jsonb_array_elements(p_assignments) loop
  sid:=(x->>'story_id')::uuid;
  insert into public.stories(id,canonical_label,first_detected_at,first_source_id,last_seen_at) values(sid,x->>'title',b.observed_at,b.source_id,b.observed_at) on conflict(id) do nothing;
  insert into public.story_assignments(batch_key,rank,story_id,source_id,observed_at,headline,headline_norm,url,fingerprint,published_at,terms,metadata)
  values(b.batch_key,(x->>'rank')::int,sid,b.source_id,b.observed_at,x->>'title',x->>'normalized',x->>'url',x->>'fingerprint',(x->>'published_at')::timestamptz,array(select jsonb_array_elements_text(x->'terms')),x->'match');
  affected:=array_append(affected,sid);
 end loop;
 for st in select distinct unnest(affected) loop perform public.newsboard_story_rebuild(st); end loop;
 update public.story_processing_runs set batches_processed=batches_processed+1 where id=p_run;
 update public.story_worker_state set lock_until=now()+interval '3 minutes' where id and lock_owner=p_run;
 return true;
end $$;
create function public.newsboard_story_finish(p_run uuid,p_error text default null) returns void
language plpgsql security invoker set search_path='' as $$
begin
 update public.story_processing_runs set status=case when p_error is null then 'success' else 'failed' end,completed_at=now(),error=p_error where id=p_run;
 update public.story_worker_state set lock_owner=null,lock_until=null where id and lock_owner=p_run;
end $$;

-- Public read surfaces use invoker security and only public derived data.
create function public.newsboard_story_badges() returns jsonb language sql stable security invoker set search_path='' as $$
 with counts as(select story_id,count(*) filter(where active and last_seen_at>now()-interval '2 hours') n from public.story_members group by story_id)
 select coalesce(jsonb_agg(jsonb_build_object('story_id',s.id,'source_id',m.source_id,'url',m.url,'title',m.latest_headline,'first_source_id',s.first_source_id,'publisher_count',c.n,'first_detected_at',s.first_detected_at)),'[]'::jsonb)
 from public.story_members m join public.stories s on s.id=m.story_id join counts c on c.story_id=s.id
 where m.active and m.last_seen_at>now()-interval '2 hours' and c.n>1;
$$;
create function public.newsboard_story_history(p_story uuid) returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('story',to_jsonb(s),'publisher_count',(select count(*) from public.story_members where story_id=s.id and active and last_seen_at>now()-interval '2 hours'),
 'current_number_ones',(select count(*) from public.story_members where story_id=s.id and active and current_rank=1 and last_seen_at>now()-interval '2 hours'),
 'members',coalesce((select jsonb_agg(to_jsonb(m)||jsonb_build_object('publisher',p.name) order by m.first_seen_at,m.source_id) from public.story_members m join public.sources p on p.id=m.source_id where m.story_id=s.id),'[]'::jsonb),
 'events',coalesce((select jsonb_agg(x order by x.observed_at,x.event_type) from (select o.*,p.name publisher from public.story_observations o join public.sources p on p.id=o.source_id where o.story_id=s.id order by o.observed_at,o.event_type limit 1000)x),'[]'::jsonb),
 'events_truncated',(select count(*)>1000 from public.story_observations where story_id=s.id)) from public.stories s where id=p_story;
$$;

do $$ declare t text; f record; begin
 foreach t in array array['stories','story_members','story_observations','story_processed_batches','story_assignments','story_processing_runs','story_worker_state'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 execute format('create policy service_access on public.%I for all to service_role using(true) with check(true)',t);
 end loop;
 foreach t in array array['stories','story_members','story_observations'] loop
 execute format('grant select on public.%I to anon,authenticated',t);
 execute format('create policy public_read on public.%I for select to anon,authenticated using(true)',t);
 end loop;
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname like 'newsboard_story_%' loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
revoke all on public.story_raw_batches from public,anon,authenticated;
grant select on public.story_raw_batches to service_role;
grant execute on function public.newsboard_story_badges(),public.newsboard_story_history(uuid) to anon,authenticated;
