-- Continue from the explicit small test's beginning, never the entire archive.
update public.story_worker_state set history_start=coalesce((select min(observed_at) from public.story_processed_batches),history_start) where id;

-- Advance only once the selected live window is fully consumed. Retain a
-- 15-minute overlap for ordinary late arrivals; the ledger makes it idempotent.
create or replace function public.newsboard_story_finish(p_run uuid,p_error text default null) returns void
language plpgsql security invoker set search_path='' as $$
declare r public.story_processing_runs;
begin
 select * into strict r from public.story_processing_runs where id=p_run;
 if p_error is null and r.mode='live' and not exists(
  select 1 from public.story_raw_batches b where b.observed_at>=r.window_start and b.observed_at<r.window_end
  and not exists(select 1 from public.story_processed_batches d where d.batch_key=b.batch_key)
 ) then
  update public.story_worker_state set history_start=greatest(history_start,r.window_end-interval '15 minutes') where id and lock_owner=p_run;
 end if;
 update public.story_processing_runs set status=case when p_error is null then 'success' else 'failed' end,completed_at=now(),error=p_error where id=p_run;
 update public.story_worker_state set lock_owner=null,lock_until=null where id and lock_owner=p_run;
end $$;

create function newsboard_private.invoke_story_intelligence(p_start timestamptz default null,p_end timestamptz default null)
returns bigint language plpgsql security invoker set search_path='' as $$
declare token text;
begin
 if (p_start is null) <> (p_end is null) then raise exception 'Both backfill boundaries are required'; end if;
 select decrypted_secret into strict token from vault.decrypted_secrets where name='newsboard_crawl_token';
 return net.http_post(url:='https://aknclkofrjliaecsjbnp.supabase.co/functions/v1/story-intelligence',
 headers:=jsonb_build_object('Content-Type','application/json','x-newsboard-token',token),
 body:=case when p_start is null then '{}'::jsonb else jsonb_build_object('start',p_start,'end',p_end) end,timeout_milliseconds:=120000);
end $$;
revoke all on function newsboard_private.invoke_story_intelligence(timestamptz,timestamptz) from public,anon,authenticated;
-- Offset from collection; independent HTTP request/transaction. Original cron unchanged.
select cron.schedule('newsboard-story-intelligence','1-59/5 * * * *',$cron$select newsboard_private.invoke_story_intelligence();$cron$);
