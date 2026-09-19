begin;
set local role service_role;
do $$
declare rid uuid; before_state jsonb; after_state jsonb; sid text:='__newsboard_test__';
begin
 insert into public.sources(id,name) values(sid,'Rollback-only crawler test');
 rid:=public.newsboard_start_run('manual_edge_function');
 if rid is null then raise exception 'A live crawl is active; retry this test after completion'; end if;
 if public.newsboard_start_run('manual_edge_function') is not null then raise exception 'Overlapping run was allowed'; end if;
 perform public.newsboard_save_source(jsonb_build_object('run_id',rid,'source_id',sid,'started_at',now(),'completed_at',now(),'method','http','success',true,'output',jsonb_build_object('observed_at',now(),'item',jsonb_build_object('title','Test headline','url','https://example.com/test'),'items',jsonb_build_array(jsonb_build_object('rank',1,'title','Test headline','url','https://example.com/test')))));
 select to_jsonb(c) into before_state from public.crawler_current c where source_id=sid;
 if before_state is null then raise exception 'Success not persisted'; end if;
 perform public.newsboard_finish_run(rid,null);
 rid:=public.newsboard_start_run('manual_edge_function');
 perform public.newsboard_save_source(jsonb_build_object('run_id',rid,'source_id',sid,'started_at',now(),'completed_at',now(),'method','http','success',false,'error','Test extraction failure','output',null));
 select to_jsonb(c) into after_state from public.crawler_current c where source_id=sid;
 if before_state is distinct from after_state then raise exception 'Failure erased or refreshed prior success'; end if;
 if not exists(select 1 from public.crawler_source_runs where run_id=rid and source_id=sid and not success) then raise exception 'Failure not recorded'; end if;
 perform public.newsboard_finish_run(rid,null);
 rid:=public.newsboard_start_run('manual_edge_function');
 begin
  perform public.newsboard_save_source(jsonb_build_object('run_id',rid,'source_id',sid,'started_at',now(),'completed_at',now(),'method','http','success',true,'output',jsonb_build_object('observed_at',now(),'item','{}'::jsonb,'items','[]'::jsonb)));
  raise exception 'TEST_FAILED_EMPTY_ACCEPTED';
 exception when others then
  if sqlerrm='TEST_FAILED_EMPTY_ACCEPTED' then raise; end if;
 end;
 if exists(select 1 from public.crawler_source_runs where run_id=rid) then raise exception 'Invalid snapshot partially persisted'; end if;
end $$;
reset role;
do $$ declare t text; begin
 foreach t in array array['crawler_runs','crawler_source_runs','crawler_current','crawler_snapshots','top10_runs','top10_items','top10_events'] loop
 if has_table_privilege('anon','public.'||t,'INSERT,UPDATE,DELETE') or has_table_privilege('authenticated','public.'||t,'INSERT,UPDATE,DELETE') then raise exception 'Client has write grants on %',t; end if;
 end loop;
 if has_function_privilege('anon','public.newsboard_save_source(jsonb)','EXECUTE') then raise exception 'Public persistence RPC'; end if;
 if has_table_privilege('anon','public.crawler_settings','SELECT') then raise exception 'Public secret hash access'; end if;
end $$;
select 'PASS: overlap, success, failure preservation, empty-result rejection, client permissions; rolled back' as result;
rollback;
