-- Rollback-only checks for derived health/freshness semantics.
begin;
set local role service_role;
do $$
declare sid text:='__health_test__'; browser_sid text:='__browser_health_test__'; rid uuid; health jsonb; batch text:='health:test';
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
 if health->>'health'<>'healthy' or health->>'last_success_at' is null then raise exception 'Unrelated browser failure polluted successful HTTP cycle: %',health; end if;
 rid:=public.newsboard_start_run('manual_edge_function');
 perform public.newsboard_save_source(jsonb_build_object('run_id',rid,'source_id',sid,'started_at',clock_timestamp(),'completed_at',clock_timestamp(),'method','http','success',false,'outcome','crawl_failed','http_status',503,'error','Primary unavailable'));
 perform public.newsboard_finish_run(rid,null);
	 rid:=public.newsboard_start_run('github_browser_gap_fill');
	 perform public.newsboard_queue_browser(sid); perform public.newsboard_browser_sources(rid);
	 perform public.newsboard_save_source(jsonb_build_object('run_id',rid,'source_id',sid,'started_at',clock_timestamp(),'completed_at',clock_timestamp(),'method','browser','success',true,'outcome','success','http_status',200,'output',jsonb_build_object('observed_at',clock_timestamp(),'item',jsonb_build_object('title','Recovered health fixture','url','https://example.com/health-recovered'),'items',jsonb_build_array(jsonb_build_object('rank',1,'title','Recovered health fixture','url','https://example.com/health-recovered')))));
 perform public.newsboard_finish_run(rid,null);
 health:=public.newsboard_collection_health()->sid;
 if health->>'health'<>'healthy' or health->>'last_attempt_status'<>'success' or (health->>'recovered_by_fallback')::boolean is not true or (health->>'success_rate_24h')::numeric<>1 then raise exception 'Recovered fallback was not one healthy effective cycle: %',health; end if;

 insert into public.sources(id,name) values(browser_sid,'Browser health fixture');
 insert into public.crawler_publishers(source_id,method,browser_fallback_enabled) values(browser_sid,'browser',true);
 rid:=public.newsboard_start_run('manual_edge_function');
 perform public.newsboard_save_source(jsonb_build_object('run_id',rid,'source_id',browser_sid,'started_at',clock_timestamp(),'completed_at',clock_timestamp(),'method','browser','success',false,'outcome','crawl_failed','error','Browser collector required'));
 perform public.newsboard_finish_run(rid,null);
	 rid:=public.newsboard_start_run('github_browser_gap_fill');
	 perform public.newsboard_queue_browser(browser_sid); perform public.newsboard_browser_sources(rid);
	 perform public.newsboard_save_source(jsonb_build_object('run_id',rid,'source_id',browser_sid,'started_at',clock_timestamp(),'completed_at',clock_timestamp(),'method','browser','success',true,'outcome','success','http_status',200,'output',jsonb_build_object('observed_at',clock_timestamp(),'item',jsonb_build_object('title','Browser fixture headline','url','https://example.com/browser-health'),'items',jsonb_build_array(jsonb_build_object('rank',1,'title','Browser fixture headline','url','https://example.com/browser-health')))));
 perform public.newsboard_finish_run(rid,null);
 health:=public.newsboard_collection_health()->browser_sid;
 if health->>'health'<>'healthy' or (health->>'attempts_24h')::int<>1 or (health->>'success_rate_24h')::numeric<>1 then raise exception 'Delegation notice polluted browser health: %',health; end if;
 update public.crawler_current set observed_at=now()-interval '46 minutes' where source_id=sid;
 if public.newsboard_collection_health()->sid->>'health'<>'stale' then raise exception 'Old observation not stale'; end if;
end $$;
select 'PASS: healthy; unrelated browser failure ignored; recovered fallback; delegated browser notice ignored; stale' result;
rollback;
