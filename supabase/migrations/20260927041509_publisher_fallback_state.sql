-- Per-publisher work and outcome; existing source-run rows remain the attempt log.
alter table public.crawler_publishers add column browser_fallback_enabled boolean not null default false;
update public.crawler_publishers set browser_fallback_enabled=true where source_id in ('abc1','cbs1','latimes1','npr1','bbc1','fox1','ap1','cnn1','nbc1','guardian1','usat1','yahoo1');
create table public.crawler_browser_jobs (
 source_id text primary key references public.sources(id),
 primary_run_id uuid references public.crawler_runs(id), requested_at timestamptz not null,
 status text not null check(status in('pending','running','succeeded','failed','cancelled')),
 browser_run_id uuid references public.crawler_runs(id), started_at timestamptz, completed_at timestamptz,
 deadline_at timestamptz, error text, failures int not null default 0, next_retry_at timestamptz
);
alter table public.crawler_browser_jobs enable row level security;
-- Only sanitized publisher attempt metadata, never credentials/dispatch API details.
grant select on public.crawler_browser_jobs to anon,authenticated,service_role;
grant insert,update,delete on public.crawler_browser_jobs to service_role;
create policy read_publisher_attempt_state on public.crawler_browser_jobs for select to anon,authenticated using(true);

create function public.newsboard_queue_browser(p_source text,p_primary uuid default null) returns void
language plpgsql set search_path='' as $$
begin
 insert into public.crawler_browser_jobs(source_id,primary_run_id,requested_at,status,deadline_at)
 values(p_source,p_primary,now(),'pending',now()+interval '20 minutes')
 on conflict(source_id) do update set primary_run_id=coalesce(excluded.primary_run_id,crawler_browser_jobs.primary_run_id),
 requested_at=excluded.requested_at,status='pending',browser_run_id=null,started_at=null,completed_at=null,deadline_at=greatest(excluded.deadline_at,crawler_browser_jobs.next_retry_at+interval '20 minutes'),error=null
 where crawler_browser_jobs.status not in('pending','running');
end $$;

create function public.newsboard_source_attempt_state() returns trigger language plpgsql set search_path='' as $$
declare kind text; cfg public.crawler_publishers;
begin
 select trigger into kind from public.crawler_runs where id=new.run_id;
 select * into cfg from public.crawler_publishers where source_id=new.source_id;
 if not found then return new; end if;
 if kind in ('github_backup','github_browser_gap_fill') then
  -- A superseded browser result cannot rewrite a newer job. Manual backup can
  -- satisfy a pending job, but a source omitted from a run is never failed here.
  insert into public.crawler_browser_jobs(source_id,requested_at,status,browser_run_id,started_at,completed_at,error,failures,next_retry_at)
  values(new.source_id,new.started_at,case when new.success then 'succeeded' else 'failed' end,new.run_id,new.started_at,new.completed_at,new.error,
   case when new.success then 0 else 1 end,case when not new.success then now()+interval '2 minutes' end)
  on conflict(source_id) do update set status=excluded.status,browser_run_id=new.run_id,started_at=new.started_at,completed_at=new.completed_at,deadline_at=null,error=new.error,
   failures=case when new.success then 0 else crawler_browser_jobs.failures+1 end,
   next_retry_at=case when new.success then null else now()+make_interval(secs=>least(1800,120*power(2,least(crawler_browser_jobs.failures,4)))::int) end
  where crawler_browser_jobs.browser_run_id=new.run_id or (crawler_browser_jobs.status<>'running' and new.started_at>=crawler_browser_jobs.requested_at);
 elsif new.success then
  update public.crawler_browser_jobs set status='cancelled',completed_at=new.completed_at,deadline_at=null,error=null,failures=0,next_retry_at=null
  where source_id=new.source_id and requested_at<=new.completed_at;
 elsif cfg.browser_fallback_enabled then
  -- Browser-required routing notices aren't HTTP extraction failures. Only
  -- request work when their observation is due; true HTTP misses queue now.
  if cfg.method='http' or not exists(select 1 from public.crawler_current where source_id=new.source_id and observed_at>now()-interval '420 seconds') then
   perform public.newsboard_queue_browser(new.source_id,new.run_id);
  end if;
 end if;
 return new;
end $$;
create trigger source_attempt_state after insert or update of success,error on public.crawler_source_runs for each row execute function public.newsboard_source_attempt_state();

create function public.newsboard_prepare_browser_jobs() returns void language plpgsql set search_path='' as $$
declare p record;
begin
 -- Expire only work that was explicitly assigned to that source/run.
 update public.crawler_browser_jobs j set status='failed',completed_at=now(),error=case when j.status='pending' then 'Browser dispatch deadline exceeded' else 'Browser attempt interrupted or timed out' end,
 failures=j.failures+1,next_retry_at=now()+make_interval(secs=>least(1800,120*power(2,least(j.failures,4)))::int)
 where j.status in('pending','running') and (j.deadline_at<=now() or (j.status='running' and exists(select 1 from public.crawler_runs r where r.id=j.browser_run_id and r.status<>'running')));
 for p in select c.source_id from public.crawler_publishers c left join public.crawler_current o using(source_id)
 left join public.crawler_browser_jobs j using(source_id)
 where c.browser_fallback_enabled and (j.source_id is null or j.status not in('pending','running')) and coalesce(j.next_retry_at,'-infinity')<=now()
 and ((c.method='browser' and coalesce(o.observed_at,'-infinity')<=now()-interval '420 seconds') or
      (c.method='http' and exists(select 1 from public.crawler_source_runs sr join public.crawler_runs r on r.id=sr.run_id where sr.source_id=c.source_id and not sr.success and r.trigger in('supabase_cron','manual_edge_function') and sr.completed_at>coalesce(o.observed_at,'-infinity'))))
 loop perform public.newsboard_queue_browser(p.source_id); end loop;
end $$;

create function public.newsboard_browser_sources(p_run uuid) returns table(source_id text) language plpgsql set search_path='' as $$
begin
 perform pg_advisory_xact_lock(794611);
 if not exists(select 1 from public.crawler_runs where id=p_run and status='running' and trigger='github_browser_gap_fill') then raise exception 'Active browser crawl required'; end if;
 perform public.newsboard_prepare_browser_jobs();
 return query update public.crawler_browser_jobs j set status='running',browser_run_id=p_run,started_at=now(),deadline_at=now()+interval '10 minutes'
 from public.crawler_publishers p where p.source_id=j.source_id and p.browser_fallback_enabled and j.status='pending' and coalesce(j.next_retry_at,'-infinity')<=now()
 returning j.source_id;
end $$;

-- Keep existing raw/Top 10 persistence intact; finalize explicitly assigned jobs.
alter function public.newsboard_finish_run(uuid,text) rename to newsboard_finish_run_before_source_jobs;
create function public.newsboard_finish_run(p_run uuid,p_error text default null) returns void language plpgsql set search_path='' as $$
begin
 perform public.newsboard_finish_run_before_source_jobs(p_run,p_error);
 update public.crawler_browser_jobs set status='failed',completed_at=now(),deadline_at=null,error=coalesce(p_error,'Browser run ended without a publisher result'),failures=failures+1,
 next_retry_at=now()+make_interval(secs=>least(1800,120*power(2,least(failures,4)))::int)
 where browser_run_id=p_run and status='running';
end $$;

-- One definition of definitive failure. Row validity is separate from attempt state.
create or replace view public.v_crawler_attempt_status with(security_invoker=true) as
select p.source_id,
 case
  when j.status in('pending','running') and j.deadline_at>now() then j.status
  when j.status in('pending','running','failed') then 'failed'
  when j.status='succeeded' then 'success'
  when a.success then 'success'
  when a.success=false and p.browser_fallback_enabled and (b.completed_at is null or b.completed_at<a.completed_at) then 'pending'
  when a.success=false and b.success and b.completed_at>=a.completed_at then 'success'
  when a.success=false then 'failed'
  when b.success then 'success'
  when b.success=false then 'failed'
  else 'pending' end as crawl_status,
 greatest(a.completed_at,b.completed_at) as completed_at,
 coalesce(j.error,case when not b.success then b.error end,case when not a.success then a.error end) as error,
 a.completed_at as primary_attempt_at,a.success as primary_success,a.error as primary_error,
 case when p.method='browser' then 'delegated' when a.success then 'succeeded' when a.success=false then 'failed' else 'unattempted' end as primary_status,
 case when j.status in('pending','running') and j.deadline_at<=now() then 'failed' else coalesce(j.status,case when b.success then 'succeeded' when b.success=false then 'failed' else 'not_requested' end) end as browser_status,
 j.requested_at as browser_requested_at,j.started_at as browser_started_at,j.completed_at as browser_completed_at,
 p.browser_fallback_enabled,
 greatest(a.completed_at,b.completed_at,j.started_at,j.requested_at) as last_attempt_at,
 greatest(f.completed_at,case when j.status='failed' then j.completed_at when j.status in('pending','running') and j.deadline_at<=now() then j.deadline_at end) as last_failure_at
from public.crawler_publishers p
left join public.crawler_browser_jobs j using(source_id)
left join lateral(select sr.* from public.crawler_source_runs sr join public.crawler_runs r on r.id=sr.run_id where sr.source_id=p.source_id and p.method='http' and r.trigger in('supabase_cron','manual_edge_function') order by sr.completed_at desc limit 1)a on true
left join lateral(select sr.* from public.crawler_source_runs sr join public.crawler_runs r on r.id=sr.run_id where sr.source_id=p.source_id and r.trigger in('github_backup','github_browser_gap_fill') order by sr.completed_at desc limit 1)b on true
left join lateral(select sr.completed_at from public.crawler_source_runs sr join public.crawler_runs r on r.id=sr.run_id where sr.source_id=p.source_id and not sr.success and (r.trigger in('github_backup','github_browser_gap_fill') or p.method='http') order by sr.completed_at desc limit 1)f on true;

revoke all on function public.newsboard_queue_browser(text,uuid),public.newsboard_source_attempt_state(),public.newsboard_prepare_browser_jobs(),public.newsboard_browser_sources(uuid),public.newsboard_finish_run(uuid,text) from public,anon,authenticated;
grant execute on function public.newsboard_queue_browser(text,uuid),public.newsboard_source_attempt_state(),public.newsboard_prepare_browser_jobs(),public.newsboard_browser_sources(uuid),public.newsboard_finish_run(uuid,text) to service_role;

create or replace function public.newsboard_browser_complete(p_attempt uuid) returns void language plpgsql set search_path='' as $$
declare a public.browser_dispatch_attempts; r public.crawler_runs;
begin
 perform pg_advisory_xact_lock(794611);
 select * into a from public.browser_dispatch_attempts where id=p_attempt for update;
 if a.status<>'running' then return; end if;
 select * into r from public.crawler_runs where id=a.crawler_run_id;
 if r.status='running' then return; end if;
 update public.browser_dispatch_attempts set status=case when r.status in ('success','skipped') then 'success' when r.status='partial' then 'partial' else 'failed' end,
 completed_at=r.completed_at,error=case when r.status in ('success','skipped') then null else 'crawler_'||r.status end where id=a.id;
 update public.browser_scheduler_settings set failures=case when r.status in ('success','skipped','partial') or r.publishers_attempted>0 then 0 else failures+1 end,
 retry_after=case when r.status in ('success','skipped','partial') or r.publishers_attempted>0 then null else now()+make_interval(secs=>least(1800,120*power(2,least(failures,4)))::int) end where id;
end $$;

create or replace function public.newsboard_browser_claim(p_has_credential boolean) returns jsonb language plpgsql set search_path='' as $$
declare cfg public.browser_scheduler_settings; a public.browser_dispatch_attempts; due timestamptz; decision text; aid uuid;
begin
 -- Same lock as newsboard_start_run: serialized decisions and crawler lease checks.
 perform pg_advisory_xact_lock(794611);
 for a in select * from public.browser_dispatch_attempts where status='running' loop
  perform public.newsboard_browser_complete(a.id);
 end loop;
 for a in select * from public.browser_dispatch_attempts where status in ('dispatching','accepted','uncertain','running') and expires_at<=now() loop
  update public.browser_dispatch_attempts set status='expired',completed_at=now(),error=case when a.crawler_run_id is null then 'workflow_did_not_start_before_deadline' else 'crawler_lease_expired' end where id=a.id;
  update public.browser_scheduler_settings set failures=failures+1,retry_after=now()+make_interval(secs=>least(1800,120*power(2,least(failures,4)))::int) where id;
 end loop;
 select * into strict cfg from public.browser_scheduler_settings where id for update;
 perform public.newsboard_prepare_browser_jobs();
 select min(greatest(requested_at,coalesce(next_retry_at,requested_at))) into due from public.crawler_browser_jobs where status='pending';
 decision:=case when not cfg.enabled then 'disabled'
  when exists(select 1 from public.browser_dispatch_attempts where status in ('dispatching','accepted','uncertain','running')) then 'dispatch_active'
  when exists(select 1 from public.crawler_runs where status='running' and started_at>now()-interval '10 minutes') then 'crawler_active'
  when cfg.retry_after>now() then 'backoff'
  when due is null or due>now() then 'fresh'
  when not p_has_credential then 'missing_credential' else 'dispatch' end;
 update public.browser_scheduler_settings set last_check_at=now(),last_due_at=due,last_decision=decision where id;
 if decision not in ('dispatch','missing_credential') then return jsonb_build_object('decision',decision,'due_at',due); end if;
 insert into public.browser_dispatch_attempts(due_at,status,expires_at,completed_at,error)
 values(due,case when p_has_credential then 'dispatching' else 'missing_credential' end,now()+interval '10 minutes',
 case when not p_has_credential then now() end,case when not p_has_credential then 'NEWSBOARD_GITHUB_DISPATCH_TOKEN_not_configured' end) returning id into aid;
 if not p_has_credential then update public.browser_scheduler_settings set retry_after=now()+interval '30 minutes' where id; end if;
 return jsonb_build_object('decision',decision,'attempt_id',aid,'due_at',due);
end $$;


-- Clear the old publisher-shared extraction backoff; dispatch/API backoff resumes normally.
update public.browser_scheduler_settings set retry_after=null,failures=0 where last_decision='backoff';
select public.newsboard_prepare_browser_jobs();

create or replace function public.newsboard_snapshot() returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object('cacheLike',jsonb_build_object('generatedAt',now(),'sources',coalesce((
 select jsonb_object_agg(p.source_id,jsonb_build_object(
 'ok',c.source_id is not null,'updatedAt',c.observed_at,'updated_at',c.observed_at,'firstSeenAt',c.first_seen_at,'lastChangeAt',c.last_change_at,'sourceName',s.name,'item',c.item,
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
