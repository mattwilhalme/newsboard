-- Rollback-only integration test: no synthetic data survives.
begin;
set local role service_role;
do $$
declare rid uuid; bad_rid uuid; stamp timestamptz:=now(); item jsonb; payload jsonb; before_ap bigint; rejected boolean; before_count bigint;
begin
 -- Use the production lease lock; retry this rollback test if a crawl is active.
 perform pg_advisory_xact_lock(794611);
 select count(*) into before_ap from public.hero_runs where source_id='ap1';
 insert into public.crawler_runs(trigger,status) values('manual_edge_function','running') returning id into rid;
 item:=jsonb_build_object('title','Deterministic AP discovery integration headline','url','https://news.google.com/rss/articles/integration_example','publishedAt',stamp-interval '1 hour','publisher','Associated Press','via','Google News','coverageScope','discovery','contentType','news');
 payload:=jsonb_build_object('run_id',rid,'source_id','apgoogle1','started_at',stamp,'completed_at',stamp,'method','http','success',true,'outcome','success','output',jsonb_build_object('source_id','apgoogle1','coverage_scope','discovery','feed_url','https://news.google.com/rss/search?q=site%3Aapnews.com%20when%3A1d&hl=en-US&gl=US&ceid=US%3Aen','observed_at',stamp,'item',item,'items',jsonb_build_array(item),'http_status',200));
 perform public.newsboard_save_source(payload);
 perform public.newsboard_save_source(payload);
 if (select count(*) from public.crawler_snapshots where run_id=rid and source_id='apgoogle1')<>1 then raise exception 'Replay must be idempotent'; end if;
 if (select items from public.crawler_current where source_id='apgoogle1')<>jsonb_build_array(item) then raise exception 'Rankless discovery must be persisted'; end if;
 if exists(select 1 from public.hero_runs where source_id='apgoogle1') or exists(select 1 from public.headline_events where source_id='apgoogle1') or exists(select 1 from public.top10_runs where source_id='apgoogle1') or exists(select 1 from public.story_raw_batches where source_id='apgoogle1') then raise exception 'Discovery contaminated homepage/rank intelligence'; end if;
 if (select count(*) from public.hero_runs where source_id='ap1')<>before_ap then raise exception 'AP history changed'; end if;
 if public.newsboard_snapshot()->'cacheLike'->'sources'->'apgoogle1'->>'kind'<>'discovery' then raise exception 'Missing public provenance'; end if;
 if public.newsboard_snapshot()->'cacheLike'->'sources' ? 'ap1' then raise exception 'Retired AP still active'; end if;
 if not(public.newsboard_snapshot()->'history'->'sources' ? 'ap1') then raise exception 'AP homepage history was hidden'; end if;
 select count(*) into before_count from public.crawler_snapshots where source_id='apgoogle1';
 perform public.newsboard_finish_run(rid,null);
 insert into public.crawler_runs(trigger,status) values('manual_edge_function','running') returning id into bad_rid;
 payload:=jsonb_set(payload,'{run_id}',to_jsonb(bad_rid));
 rejected:=false;
 begin perform public.newsboard_save_source(jsonb_set(jsonb_set(payload,'{output,items,0,rank}','1'::jsonb),'{output,item,rank}','1'::jsonb)); exception when others then rejected:=true; end;
 if not rejected then raise exception 'Ranked discovery was accepted'; end if;
 rejected:=false;
 begin perform public.newsboard_save_source(jsonb_set(payload,'{output,items}','[]'::jsonb)); exception when others then rejected:=true; end;
 if not rejected then raise exception 'Empty discovery was accepted'; end if;
 rejected:=false;
 begin perform public.newsboard_save_source(jsonb_set(payload,'{output,top10}',jsonb_build_array(item))); exception when others then rejected:=true; end;
 if not rejected then raise exception 'Top 10 discovery was accepted'; end if;
 rejected:=false;
 begin perform public.newsboard_save_source(jsonb_set(payload,'{output,feed_url}','"https://example.com"'::jsonb)); exception when others then rejected:=true; end;
 if not rejected then raise exception 'Wrong feed provenance was accepted'; end if;
 -- Failures record health without replacing the last good observation.
 perform public.newsboard_save_source(jsonb_set(jsonb_set(jsonb_set(payload,'{success}','false'::jsonb),'{outcome}','"crawl_failed"'::jsonb),'{output}','null'::jsonb));
 if (select items from public.crawler_current where source_id='apgoogle1')<>jsonb_build_array(item) or (select count(*) from public.crawler_snapshots where source_id='apgoogle1')<>before_count then raise exception 'Failure replaced good discovery'; end if;
 if has_function_privilege('anon','public.newsboard_save_source(jsonb)','execute') or has_function_privilege('anon','public.newsboard_save_discovery(jsonb)','execute') then raise exception 'Anonymous write access'; end if;
end $$;
set local role anon;
select public.newsboard_snapshot()->'cacheLike'->'sources'->'apgoogle1'->>'sourceName' as public_discovery_name;
rollback;
