-- Publisher collection outcomes are health metadata, separate from last-good stories.
alter table public.crawler_source_runs
 add column outcome text
 check(outcome in ('success','blocked','crawl_failed','infrastructure_error'));
update public.crawler_source_runs set outcome=case when success then 'success' else 'crawl_failed' end;

alter table public.crawler_browser_jobs
 add column last_outcome text
 check(last_outcome in ('success','blocked','crawl_failed','infrastructure_error'));

create or replace function public.newsboard_save_source(p jsonb) returns void language plpgsql set search_path='' as $$
declare raw jsonb:=p; sid text:=p->>'source_id'; rid uuid:=(p->>'run_id')::uuid; msg text; succeeded boolean:=(p->>'success')::boolean; result text:=coalesce(p->>'outcome',case when (p->>'success')::boolean then 'success' else 'crawl_failed' end);
begin
 if result not in ('success','blocked','crawl_failed','infrastructure_error') or succeeded<>(result='success') then raise exception 'Invalid crawl outcome'; end if;
 perform 1 from public.sources where id=sid for update;
 if exists(select 1 from public.crawler_source_runs where run_id=rid and source_id=sid) then return; end if;
 if succeeded then
  raw:=jsonb_set(p,'{output,items}',jsonb_build_array((p->'output'->'item')||jsonb_build_object('rank',1,'slot_key','hero:1')));
 end if;
 perform public.newsboard_save_source_base(raw);
 update public.crawler_source_runs set outcome=result where run_id=rid and source_id=sid;
 if not succeeded or p->'output'->'top10' is null or p->'output'->'top10'='null'::jsonb then return; end if;
 begin perform public.newsboard_save_top10(p);
 exception when others then get stacked diagnostics msg=message_text; update public.crawler_source_runs set top10_status='failed',top10_error=left(msg,500) where run_id=rid and source_id=sid; end;
end $$;

drop trigger source_attempt_state on public.crawler_source_runs;
create trigger source_attempt_state after insert or update of success,error,outcome on public.crawler_source_runs for each row execute function public.newsboard_source_attempt_state();

create or replace function public.newsboard_source_attempt_state() returns trigger language plpgsql set search_path='' as $$
declare kind text; cfg public.crawler_publishers; delay_seconds int;
begin
 if new.outcome is null then return new; end if;
 select trigger into kind from public.crawler_runs where id=new.run_id;
 select * into cfg from public.crawler_publishers where source_id=new.source_id;
 if not found then return new; end if;
 if kind in ('github_backup','github_browser_gap_fill') then
  delay_seconds:=case when new.outcome='blocked' then least(28800,1800*power(2,least(coalesce((select failures from public.crawler_browser_jobs where source_id=new.source_id),0),4)))::int else least(1800,120*power(2,least(coalesce((select failures from public.crawler_browser_jobs where source_id=new.source_id),0),4)))::int end;
  insert into public.crawler_browser_jobs(source_id,requested_at,status,browser_run_id,started_at,completed_at,error,failures,next_retry_at,last_outcome)
  values(new.source_id,new.started_at,case when new.success then 'succeeded' else 'failed' end,new.run_id,new.started_at,new.completed_at,new.error,case when new.success then 0 else 1 end,case when not new.success then now()+make_interval(secs=>delay_seconds) end,new.outcome)
  on conflict(source_id) do update set status=excluded.status,browser_run_id=new.run_id,started_at=new.started_at,completed_at=new.completed_at,deadline_at=null,error=new.error,last_outcome=new.outcome,
   failures=case when new.success then 0 else crawler_browser_jobs.failures+1 end,
   next_retry_at=case when new.success then null else now()+make_interval(secs=>case when new.outcome='blocked' then least(28800,1800*power(2,least(crawler_browser_jobs.failures,4)))::int else least(1800,120*power(2,least(crawler_browser_jobs.failures,4)))::int end) end
  where crawler_browser_jobs.browser_run_id=new.run_id or (crawler_browser_jobs.status<>'running' and new.started_at>=crawler_browser_jobs.requested_at);
 elsif new.success then
  update public.crawler_browser_jobs set status='cancelled',completed_at=new.completed_at,deadline_at=null,error=null,failures=0,next_retry_at=null,last_outcome='success' where source_id=new.source_id and requested_at<=new.completed_at;
 elsif cfg.browser_fallback_enabled then
  if cfg.method='http' or not exists(select 1 from public.crawler_current where source_id=new.source_id and observed_at>now()-interval '420 seconds') then perform public.newsboard_queue_browser(new.source_id,new.run_id); end if;
 end if;
 return new;
end $$;

-- Publisher-level misses are completed runs; only Newsboard infrastructure faults fail a run.
create or replace function public.newsboard_finish_run(p_run uuid,p_error text default null) returns void language plpgsql set search_path='' as $$
begin
 update public.crawler_runs set completed_at=now(),duration_ms=extract(epoch from(now()-started_at))*1000,publishers_attempted=s.n,publishers_succeeded=s.ok,publishers_failed=s.n-s.ok,
 status=case when p_error is not null or s.infrastructure_errors>0 then 'failed' when s.n=0 then 'success' when s.ok<s.n then 'partial' else 'success' end,error_summary=coalesce(p_error,s.errors)
 from(select count(*)::int n,count(*) filter(where success)::int ok,count(*) filter(where outcome='infrastructure_error')::int infrastructure_errors,string_agg(source_id||': '||outcome||': '||error,'; ') filter(where not success) errors from public.crawler_source_runs where run_id=p_run)s where id=p_run and status='running';
 update public.crawler_browser_jobs set status='failed',completed_at=now(),deadline_at=null,error=coalesce(p_error,'Browser run ended without a publisher result'),last_outcome='infrastructure_error',failures=failures+1,next_retry_at=now()+make_interval(secs=>least(1800,120*power(2,least(failures,4)))::int) where browser_run_id=p_run and status='running';
end $$;

revoke all on function public.newsboard_save_source(jsonb),public.newsboard_source_attempt_state(),public.newsboard_finish_run(uuid,text) from public,anon,authenticated;
grant execute on function public.newsboard_save_source(jsonb),public.newsboard_source_attempt_state(),public.newsboard_finish_run(uuid,text) to service_role;
