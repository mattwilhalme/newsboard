begin;
set local role service_role;
do $$
declare worker uuid; story uuid:=gen_random_uuid(); other_story uuid:=gen_random_uuid(); raw_run uuid; snap uuid; first_snap uuid; early_snap uuid; raw_top uuid; payload jsonb; count_before int; t timestamptz:='2026-09-18T12:00:00Z';
begin
 insert into public.sources(id,name,kind,home_url) values('story_test_abc','Story test ABC','hero','https://abcnews.com'),('story_test_ap','Story test AP','hero','https://apnews.com');
 worker:=public.newsboard_story_begin(t,t+interval '1 hour');
 if worker is null then raise exception 'Story worker busy; retry test later'; end if;
 -- First arrival at #6, then #1 with rewritten headline and URL.
 for i in 0..1 loop
  insert into public.crawler_runs(trigger,status) values('github_backup','success') returning id into raw_run;
  insert into public.top10_runs(source_id,observed_at,ok,crawler_run_id) values('story_test_abc',t+i*interval '5 minutes',true,raw_run) returning id into raw_top;
  insert into public.crawler_snapshots(run_id,source_id,observed_at,items) values(raw_run,'story_test_abc',t+i*interval '5 minutes',jsonb_build_array(jsonb_build_object('rank',case when i=0 then 6 else 1 end,'title',case when i=0 then 'Original earthquake headline' else 'Rewritten earthquake headline' end,'url','https://abcnews.com/story/'||i))) returning id into snap;
  if i=0 then first_snap:=snap; end if;
  payload:=jsonb_build_array(jsonb_build_object('rank',case when i=0 then 6 else 1 end,'story_id',story,'title',case when i=0 then 'Original earthquake headline' else 'Rewritten earthquake headline' end,'normalized',case when i=0 then 'original earthquake headline' else 'rewritten earthquake headline' end,'url','https://abcnews.com/story/'||i,'terms',jsonb_build_array('earthquake'),'match',jsonb_build_object('decision','test')));
  perform public.newsboard_story_commit(worker,'snapshot:'||snap,payload);
 end loop;
 assert (select first_rank=6 and peak_rank=1 and current_rank=1 and first_number_one_at=t+interval '5 minutes' from public.story_members where story_id=story),'rank aggregates';
 assert (select count(*)=1 from public.story_observations where story_id=story and event_type='RANK_CHANGED'),'rank event';
 assert (select count(*)=1 from public.story_observations where story_id=story and event_type='HEADLINE_CHANGED'),'headline event';
 assert (select count(*)=1 from public.story_observations where story_id=story and event_type='URL_CHANGED'),'URL event';
 select count(*) into count_before from public.story_observations where story_id=story;
 assert not public.newsboard_story_commit(worker,'snapshot:'||snap,payload),'idempotent batch';
 assert (select count(*)=count_before from public.story_observations where story_id=story),'no duplicated events';
 update public.story_observations set created_at='2020-01-01' where story_id=story;
 perform public.newsboard_story_rebuild(story);
 assert (select count(*)=count_before from public.story_observations where story_id=story and created_at='2020-01-01'),'unchanged event rows retained';
 -- Earlier publisher discovered via a bounded out-of-order backfill.
 insert into public.crawler_snapshots(source_id,observed_at,items) values('story_test_ap',t-interval '5 minutes','[{"rank":1,"title":"Earlier AP detection","url":"https://apnews.com/article/earthquake"}]') returning id into early_snap;
 perform public.newsboard_story_commit(worker,'snapshot:'||early_snap,jsonb_build_array(jsonb_build_object('rank',1,'story_id',story,'title','Earlier AP detection','normalized','earlier ap detection','url','https://apnews.com/article/earthquake','terms',jsonb_build_array('earthquake'),'match','{}'::jsonb)));
 assert (select first_source_id='story_test_ap' and first_detected_at=t-interval '5 minutes' from public.stories where id=story),'earliest actual detection corrected';
 assert (select count(*)=1 from public.story_observations where story_id=story and event_type='FIRST_DETECTED' and source_id='story_test_ap'),'exactly one origin';
 assert (select count(*)=1 from public.story_observations where story_id=story and event_type='PUBLISHER_PICKUP' and source_id='story_test_abc'),'old origin becomes pickup';
 -- Next successful Top 10 no longer contains this story.
 insert into public.crawler_runs(trigger,status) values('github_backup','success') returning id into raw_run;
 insert into public.top10_runs(source_id,observed_at,ok,crawler_run_id) values('story_test_abc',t+interval '10 minutes',true,raw_run) returning id into raw_top;
 insert into public.crawler_snapshots(run_id,source_id,observed_at,items) values(raw_run,'story_test_abc',t+interval '10 minutes','[{"rank":1,"title":"Other unrelated story","url":"https://abcnews.com/story/other"}]') returning id into snap;
 begin
  perform public.newsboard_story_commit(worker,'snapshot:'||snap,'[]');
  raise exception 'Expected incomplete processing failure';
 exception when others then
  if sqlerrm<>'Incomplete story assignments' then raise; end if;
 end;
 assert exists(select 1 from public.crawler_snapshots where id=snap),'raw evidence survives intelligence failure';
 assert not exists(select 1 from public.story_processed_batches where batch_key='snapshot:'||snap),'failed processing is retryable';
 perform public.newsboard_story_commit(worker,'snapshot:'||snap,jsonb_build_array(jsonb_build_object('rank',1,'story_id',other_story,'title','Other unrelated story','normalized','other unrelated story','url','https://abcnews.com/story/other','terms',jsonb_build_array('other'),'match','{}'::jsonb)));
 assert (select not active and current_rank is null from public.story_members where story_id=story and source_id='story_test_abc'),'exit deactivates membership';
 assert (select count(*)=1 from public.story_observations where story_id=story and event_type='EXITED_TOP10'),'Top 10 exit';
 assert not exists(select 1 from public.story_assignments where story_id=story and published_at is not null),'no invented publication time';
 perform public.newsboard_story_finish(worker,null);
end $$;
rollback;
