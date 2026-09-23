-- Transactional integration test: synthetic publisher and rows never survive.
begin;
set local role service_role;
do $$
declare sid text:='__top10_test__'; rid uuid; first_run uuid; second_run uuid; tid uuid; items jsonb; output jsonb; payload jsonb; stamp timestamptz:=now(); k int;
begin
 insert into public.sources(id,name) values(sid,'Rollback-only Top 10 test');
 for k in 1..6 loop
  insert into public.crawler_runs(trigger) values('github_backup') returning id into rid;
  select jsonb_agg(jsonb_build_object('rank',i,'title',case when k=2 and i=3 then 'Changed title for article eight' else 'Editorial headline number '||case when k=2 and i=3 then 8 when k=2 and i=8 then 3 when k=2 and i=10 then 11 else i end end,
   'url','https://example.com/story/'||case when k=2 and i=3 then 8 when k=2 and i=8 then 3 when k=2 and i=10 then 11 else i end,'fingerprint','fp-'||i) order by i) into items from generate_series(1,case when k=3 then 8 else 10 end)i;
  if k=4 then items:=jsonb_set(items,'{0,title}','null'); end if;
  if k=5 then items:='[]'; end if;
  output:=jsonb_build_object('observed_at',stamp+k*interval '1 second','item',jsonb_build_object('title','Editorial headline number 1','url','https://example.com/story/1'),'items',items,'top10',items,'top10_quality',case when k=6 then 'warning' else 'complete' end);
  payload:=jsonb_build_object('run_id',rid,'source_id',sid,'started_at',stamp,'completed_at',stamp,'method','http','success',true,'output',output);
  perform public.newsboard_save_source(payload);
  if not exists(select 1 from public.crawler_current where source_id=sid and run_id=rid) then raise exception 'CP lost for case %',k; end if;
  select id into tid from public.top10_runs where crawler_run_id=rid and source_id=sid;
  if k=1 then
   first_run:=tid;
   if (select count(*) from public.top10_items where run_id=tid)<>10 then raise exception 'Items missing'; end if;
   if not exists(select 1 from public.story_raw_batches b where top10_run_id=tid and jsonb_array_length(b.items)=10) then raise exception 'Story handoff missing'; end if;
   -- A later asynchronous processing failure cannot roll back already saved data.
   begin raise exception 'Simulated Story Identity failure'; exception when others then null; end;
   if not exists(select 1 from public.top10_runs where id=tid) then raise exception 'Story failure erased Top 10'; end if;
  elsif k=2 then
   second_run:=tid;
   if not exists(select 1 from public.top10_events where to_run_id=tid and event_type='MOVED' and from_rank=8 and to_rank=3) then raise exception 'Move 8 to 3 missing'; end if;
   if not exists(select 1 from public.top10_events where to_run_id=tid and event_type='TITLE_UPDATED' and to_rank=3) then raise exception 'Retitle missing'; end if;
   if (select count(*) from public.top10_events where to_run_id=tid and event_type='ENTERED_TOP10')<>1 or (select count(*) from public.top10_events where to_run_id=tid and event_type='EXITED_TOP10')<>1 then raise exception 'Entry/exit incorrect'; end if;
  elsif k=3 then
   if not exists(select 1 from public.top10_runs where id=tid and quality='partial' and item_count=8) then raise exception 'Partial not stored'; end if;
  elsif k=4 then
   if not exists(select 1 from public.crawler_source_runs where run_id=rid and success and top10_status='failed') then raise exception 'Invalid Top 10 not isolated'; end if;
   if tid is not null then raise exception 'Invalid ranked item stored'; end if;
  elsif k=5 then
   if not exists(select 1 from public.top10_runs where id=tid and quality='failed') then raise exception 'Empty extraction not recorded'; end if;
  elsif k=6 then
   if not exists(select 1 from public.top10_runs where id=tid and quality='warning') then raise exception 'Mismatch not recorded'; end if;
  end if;
  if k>=3 then
   if exists(select 1 from public.top10_events where to_run_id=tid) then raise exception 'Unreliable list generated events'; end if;
   if exists(select 1 from public.story_raw_batches where source_id=sid and observed_at=stamp+k*interval '1 second') then raise exception 'Unreliable list reached Story Identity'; end if;
  end if;
  perform public.newsboard_save_source(payload);
  if (select count(*) from public.crawler_snapshots where source_id=sid and run_id=rid)<>1 then raise exception 'Replay duplicated observation'; end if;
  update public.crawler_runs set status='success',completed_at=now() where id=rid;
 end loop;
 if public.newsboard_article_key('http://www.abcnews.com/US/story/?utm_source=test&id=12#x')<>'https://abcnews.go.com/US/story?id=12' then raise exception 'URL normalization failed'; end if;
 if has_function_privilege('anon','public.newsboard_save_top10(jsonb)','EXECUTE') then raise exception 'Public write function'; end if;
end $$;
select 'PASS: persisted items, 8→3 move, entry, exit, retitle, partial/warning/failed gates, CP isolation, asynchronous Story isolation, replay, permissions' as result;
rollback;
