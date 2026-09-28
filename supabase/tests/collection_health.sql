-- Rollback-only checks for derived health/freshness semantics.
begin;
set local role service_role;
do $$
declare sid text:='__health_test__'; rid uuid; health jsonb; batch text:='health:test';
begin
 if exists(select 1 from public.crawler_runs where status='running') then raise exception 'Live crawl active: retry test when idle'; end if;
 insert into public.sources(id,name) values(sid,'Health fixture');
 insert into public.crawler_publishers(source_id,method,browser_fallback_enabled) values(sid,'http',true);
 rid:=public.newsboard_start_run('manual_edge_function');
 perform public.newsboard_save_source(jsonb_build_object('run_id',rid,'source_id',sid,'started_at',clock_timestamp(),'completed_at',clock_timestamp(),'method','http','success',true,'outcome','success','output',jsonb_build_object('observed_at',clock_timestamp(),'item',jsonb_build_object('title','Trustworthy retained health fixture','url','https://example.com/health'),'items','[{}]'::jsonb)));
 perform public.newsboard_finish_run(rid,null);
 health:=public.newsboard_collection_health()->sid;
 if health->>'health'<>'healthy' then raise exception 'Recent success not healthy: %',health; end if;
 rid:=public.newsboard_start_run('github_browser_gap_fill'); perform public.newsboard_queue_browser(sid); perform public.newsboard_browser_sources(rid);
 perform public.newsboard_save_source(jsonb_build_object('run_id',rid,'source_id',sid,'started_at',clock_timestamp(),'completed_at',clock_timestamp(),'method','browser','success',false,'outcome','blocked','http_status',403,'error','HTTP 403'));
 perform public.newsboard_finish_run(rid,null);
 health:=public.newsboard_collection_health()->sid;
 if health->>'health'<>'blocked' or health->>'last_success_at' is null then raise exception 'Blocked attempt erased last-good or classification: %',health; end if;
 update public.crawler_current set observed_at=now()-interval '46 minutes' where source_id=sid;
 if public.newsboard_collection_health()->sid->>'health'<>'stale' then raise exception 'Old observation not stale'; end if;
end $$;
select 'PASS: healthy; blocked with retained observation; stale' result;
rollback;
