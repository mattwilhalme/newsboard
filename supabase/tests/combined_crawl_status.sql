-- Execute inside a transaction; fixtures never persist.
begin;
do $$
declare sid text:='__combined_status_test__'; general uuid; browser uuid; actual text;
begin
 insert into public.sources(id,name) values(sid,'Rollback-only combined crawl test');
 insert into public.crawler_publishers(source_id,method) values(sid,'browser');
 insert into public.crawler_runs(trigger,status,started_at) values('manual_edge_function','failed',now()-interval '2 minutes') returning id into general;
 insert into public.crawler_source_runs(run_id,source_id,started_at,completed_at,collection_method,success,duration_ms,error)
 values(general,sid,now()-interval '2 minutes',now()-interval '1 minute','http',false,100,'General crawler miss');
 select crawl_status into actual from public.v_crawler_attempt_status where source_id=sid;
 if actual<>'pending' then raise exception 'General miss must be pending: %',actual; end if;
 insert into public.crawler_runs(trigger,status,started_at) values('github_browser_gap_fill','running',now()) returning id into browser;
 select crawl_status into actual from public.v_crawler_attempt_status where source_id=sid;
 if actual<>'running' then raise exception 'Browser attempt must be running: %',actual; end if;
 insert into public.crawler_source_runs(run_id,source_id,started_at,completed_at,collection_method,success,duration_ms)
 values(browser,sid,now(),now()+interval '1 second','browser',true,100);
 select crawl_status into actual from public.v_crawler_attempt_status where source_id=sid;
 if actual<>'success' then raise exception 'Browser success must win: %',actual; end if;
 update public.crawler_source_runs set success=false,error='Browser failed' where run_id=browser;
 select crawl_status into actual from public.v_crawler_attempt_status where source_id=sid;
 if actual<>'failed' then raise exception 'Both methods failed must be final: %',actual; end if;
 update public.crawler_source_runs set completed_at=now()+interval '2 seconds' where run_id=general;
 select crawl_status into actual from public.v_crawler_attempt_status where source_id=sid;
 if actual<>'pending' then raise exception 'A new general attempt must queue a browser retry: %',actual; end if;
 update public.crawler_source_runs set completed_at=now()-interval '1 minute' where run_id=general;
 delete from public.crawler_source_runs where run_id=browser;
 update public.crawler_runs set started_at=now()-interval '11 minutes' where id=browser;
 select crawl_status into actual from public.v_crawler_attempt_status where source_id=sid;
 if actual<>'failed' then raise exception 'Browser timeout must fail: %',actual; end if;
 update public.crawler_runs set status='failed',started_at=now() where id=browser;
 select crawl_status into actual from public.v_crawler_attempt_status where source_id=sid;
 if actual<>'failed' then raise exception 'Interrupted browser run must fail: %',actual; end if;
 delete from public.crawler_runs where id=browser;
 update public.crawler_source_runs set completed_at=now()-interval '21 minutes' where run_id=general;
 select crawl_status into actual from public.v_crawler_attempt_status where source_id=sid;
 if actual<>'failed' then raise exception 'Unclaimed delegation must time out: %',actual; end if;
end $$;
select 'PASS: pending, running, browser success, both failed, browser timeout, interruption, queue timeout' as result;
rollback;
