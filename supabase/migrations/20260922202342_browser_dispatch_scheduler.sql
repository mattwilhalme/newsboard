-- Private scheduling state: no public dashboard access or credentials in rows.
create table public.browser_scheduler_settings (
 id boolean primary key default true check(id), enabled boolean not null default false,
 token_hash text not null, last_check_at timestamptz, last_due_at timestamptz,
 last_decision text, retry_after timestamptz, failures int not null default 0
);
create table public.browser_dispatch_attempts (
 id uuid primary key default gen_random_uuid(), due_at timestamptz not null,
 claimed_at timestamptz not null default now(), dispatched_at timestamptz,
 status text not null check(status in ('dispatching','accepted','uncertain','running','success','partial','failed','rejected','expired','missing_credential')),
 expires_at timestamptz not null, github_status int, github_request_id text,
 github_run_id bigint, github_runner_started_at timestamptz,
 crawler_run_id uuid unique references public.crawler_runs(id), completed_at timestamptz, error text
);
create unique index browser_dispatch_one_active on public.browser_dispatch_attempts((true))
 where status in ('dispatching','accepted','uncertain','running');
create index browser_dispatch_recent on public.browser_dispatch_attempts(claimed_at desc);
alter table public.browser_scheduler_settings enable row level security;
alter table public.browser_dispatch_attempts enable row level security;
revoke all on public.browser_scheduler_settings,public.browser_dispatch_attempts from public,anon,authenticated;
grant select,insert,update,delete on public.browser_scheduler_settings,public.browser_dispatch_attempts to service_role;

do $$ declare token text:=encode(extensions.gen_random_bytes(32),'hex'); begin
 perform vault.create_secret(token,'newsboard_browser_dispatch_token','Private Cron to browser-dispatch Edge authentication');
 insert into public.browser_scheduler_settings(id,token_hash) values(true,encode(extensions.digest(token,'sha256'),'hex'));
end $$;

create function public.newsboard_browser_complete(p_attempt uuid) returns void language plpgsql set search_path='' as $$
declare a public.browser_dispatch_attempts; r public.crawler_runs;
begin
 perform pg_advisory_xact_lock(794611);
 select * into a from public.browser_dispatch_attempts where id=p_attempt for update;
 if a.status<>'running' then return; end if;
 select * into r from public.crawler_runs where id=a.crawler_run_id;
 if r.status='running' then return; end if;
 update public.browser_dispatch_attempts set status=case when r.status in ('success','skipped') then 'success' when r.status='partial' then 'partial' else 'failed' end,
 completed_at=r.completed_at,error=case when r.status in ('success','skipped') then null else 'crawler_'||r.status end where id=a.id;
 update public.browser_scheduler_settings set failures=case when r.status in ('success','skipped') then 0 else failures+1 end,
 retry_after=case when r.status in ('success','skipped') then null else now()+make_interval(secs=>least(1800,120*power(2,least(failures,4)))::int) end where id;
end $$;

create function public.newsboard_browser_claim(p_has_credential boolean) returns jsonb language plpgsql set search_path='' as $$
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
 select min(coalesce(c.observed_at,'-infinity'::timestamptz)+interval '420 seconds') into due
 from public.crawler_publishers p left join public.crawler_current c using(source_id)
 where p.method='browser' and p.source_id in ('ap1','cnn1','nbc1','guardian1','usat1','yahoo1');
 -- No observation has no finite due timestamp: first check is the due time.
 if due='-infinity'::timestamptz then due:=now(); end if;
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

create function public.newsboard_browser_mark_sent(p_attempt uuid) returns boolean language plpgsql set search_path='' as $$
begin
 perform pg_advisory_xact_lock(794611);
 update public.browser_dispatch_attempts set dispatched_at=now()
 where id=p_attempt and status='dispatching' and expires_at>now() and dispatched_at is null;
 return found;
end $$;

create function public.newsboard_browser_dispatch_result(p_attempt uuid,p_status int,p_request_id text default null,p_run_id bigint default null,p_retry_seconds int default 120) returns void language plpgsql set search_path='' as $$
declare a public.browser_dispatch_attempts;
begin
 perform pg_advisory_xact_lock(794611);
 select * into strict a from public.browser_dispatch_attempts where id=p_attempt for update;
 -- A fast GitHub worker may already be running; never overwrite its outcome.
 update public.browser_dispatch_attempts set github_status=p_status,
 github_request_id=left(p_request_id,100),github_run_id=coalesce(github_run_id,p_run_id) where id=p_attempt;
 if a.status<>'dispatching' then return; end if;
 update public.browser_dispatch_attempts set status=case when p_status in (200,204) then 'accepted' when p_status is null then 'uncertain' else 'rejected' end,
 error=case when p_status in (200,204) then null when p_status is null then 'github_transport_outcome_unknown' else 'github_http_'||p_status end,
 completed_at=case when p_status is not null and p_status not in (200,204) then now() end where id=p_attempt;
 if p_status is not null and p_status not in (200,204) then
  update public.browser_scheduler_settings set failures=failures+1,
  retry_after=now()+make_interval(secs=>greatest(120,least(3600,p_retry_seconds),least(1800,120*power(2,least(failures,4)))::int)) where id;
 end if;
end $$;

create function public.newsboard_browser_start(p_attempt uuid,p_github_run_id bigint,p_runner_started_at timestamptz) returns uuid language plpgsql set search_path='' as $$
declare a public.browser_dispatch_attempts; rid uuid;
begin
 perform pg_advisory_xact_lock(794611);
 select * into a from public.browser_dispatch_attempts where id=p_attempt for update;
 if not found or a.status not in ('dispatching','accepted','uncertain') or a.expires_at<=now() then return null; end if;
 rid:=public.newsboard_start_run('github_browser_gap_fill');
 if rid is null then
  update public.browser_dispatch_attempts set status='failed',completed_at=now(),error='crawler_lease_busy',github_run_id=p_github_run_id,github_runner_started_at=p_runner_started_at where id=p_attempt;
  update public.browser_scheduler_settings set retry_after=now()+interval '2 minutes' where id;
  return null;
 end if;
 update public.browser_dispatch_attempts set status='running',crawler_run_id=rid,github_run_id=p_github_run_id,
 github_runner_started_at=p_runner_started_at,expires_at=now()+interval '10 minutes' where id=p_attempt;
 return rid;
end $$;

create function public.newsboard_browser_scheduler_status() returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('scheduler',(select to_jsonb(s)-'token_hash' from public.browser_scheduler_settings s where id),
 'attempts',(select coalesce(jsonb_agg(a),'[]') from (select * from public.browser_dispatch_attempts order by claimed_at desc limit 10)a),
 'last_completed_browser_crawl',(select to_jsonb(r) from public.crawler_runs r where trigger in ('github_browser_gap_fill','github_backup') and completed_at is not null order by completed_at desc limit 1),
 'observations',(select jsonb_agg(jsonb_build_object('source_id',p.source_id,'observed_at',c.observed_at,'age_seconds',extract(epoch from(now()-c.observed_at)))) from public.crawler_publishers p left join public.crawler_current c using(source_id) where p.method='browser'));
$$;
revoke all on function public.newsboard_browser_claim(boolean),public.newsboard_browser_mark_sent(uuid),public.newsboard_browser_dispatch_result(uuid,int,text,bigint,int),public.newsboard_browser_start(uuid,bigint,timestamptz),public.newsboard_browser_complete(uuid),public.newsboard_browser_scheduler_status() from public,anon,authenticated;
grant execute on function public.newsboard_browser_claim(boolean),public.newsboard_browser_mark_sent(uuid),public.newsboard_browser_dispatch_result(uuid,int,text,bigint,int),public.newsboard_browser_start(uuid,bigint,timestamptz),public.newsboard_browser_complete(uuid),public.newsboard_browser_scheduler_status() to service_role;

create function newsboard_private.invoke_browser_dispatch() returns bigint language plpgsql set search_path='' as $$
declare token text;
begin
 select decrypted_secret into strict token from vault.decrypted_secrets where name='newsboard_browser_dispatch_token';
 return net.http_post(url:='https://aknclkofrjliaecsjbnp.supabase.co/functions/v1/newsboard-browser-dispatch',headers:=jsonb_build_object('Content-Type','application/json','x-newsboard-token',token),body:='{}',timeout_milliseconds:=30000);
end $$;
revoke all on function newsboard_private.invoke_browser_dispatch() from public,anon,authenticated;
-- Stage the replacement safely; enable only for controlled verification/cutover.
select cron.schedule('newsboard-browser-dispatch','* * * * *',$cron$select newsboard_private.invoke_browser_dispatch();$cron$);
select cron.alter_job(jobid,active:=false) from cron.job where jobname='newsboard-browser-dispatch';
