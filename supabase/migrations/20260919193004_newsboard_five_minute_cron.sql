create schema if not exists newsboard_private;
revoke all on schema newsboard_private from public,anon,authenticated;
create table public.crawler_dispatches(id bigint generated always as identity primary key,dispatched_at timestamptz not null default now(),trigger text not null,request_id bigint not null);
create index crawler_dispatches_time_idx on public.crawler_dispatches(dispatched_at desc);
alter table public.crawler_dispatches enable row level security;
revoke all on public.crawler_dispatches from public,anon,authenticated;
grant select on public.crawler_dispatches to anon,authenticated,service_role;
create policy public_read on public.crawler_dispatches for select to anon,authenticated using(true);
create function newsboard_private.invoke_crawl(p_trigger text default 'manual_edge_function') returns bigint language plpgsql set search_path='' as $$
declare request bigint; token text;
begin
 if p_trigger not in ('supabase_cron','manual_edge_function') then raise exception 'Invalid trigger'; end if;
 select decrypted_secret into strict token from vault.decrypted_secrets where name='newsboard_crawl_token';
 request:=net.http_post(url:='https://aknclkofrjliaecsjbnp.supabase.co/functions/v1/newsboard-crawl',headers:=jsonb_build_object('Content-Type','application/json','x-newsboard-token',token),body:=jsonb_build_object('trigger',p_trigger),timeout_milliseconds:=120000);
 insert into public.crawler_dispatches(trigger,request_id) values(p_trigger,request);
 return request;
end $$;
revoke all on function newsboard_private.invoke_crawl(text) from public,anon,authenticated;
select cron.schedule('newsboard-crawl','*/5 * * * *',$cron$select newsboard_private.invoke_crawl('supabase_cron');$cron$);
