-- Feed discovery is publication evidence. It deliberately has no foreign key
-- to crawler snapshots, hero runs, Top 10 runs, or promotion observations.
create table public.feed_sources(
 id text primary key, publisher_id text not null references public.sources(id), url text not null unique,
 feed_type text not null check(feed_type in('rss','atom','unknown')), enabled boolean not null default true,
 etag text,last_modified text,last_polled_at timestamptz,last_success_at timestamptz,last_error text,http_status integer,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.publisher_articles(
 id uuid primary key default gen_random_uuid(),publisher_id text not null references public.sources(id),
 canonical_url text not null,original_feed_url text not null,headline text not null,description text,
 published_at timestamptz,modified_at timestamptz,first_seen_at timestamptz not null,last_seen_at timestamptz not null,
 first_feed_id text not null references public.feed_sources(id),last_feed_id text not null references public.feed_sources(id),
 external_id text,headline_norm text not null,metadata jsonb not null default '{}',created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(publisher_id,canonical_url)
);
create index publisher_articles_recent_idx on public.publisher_articles(first_seen_at desc);
create index publisher_articles_published_idx on public.publisher_articles(published_at desc);
create table public.feed_poll_runs(
 id bigint generated always as identity primary key,feed_id text not null references public.feed_sources(id),started_at timestamptz not null,
 completed_at timestamptz not null default now(),http_status integer,not_modified boolean not null default false,item_count integer not null default 0,error text
);
create index feed_poll_runs_time_idx on public.feed_poll_runs(started_at desc);
create table public.publisher_article_story_assignments(
 article_id uuid primary key references public.publisher_articles(id) on delete cascade,story_id uuid references public.stories(id) on delete cascade,
 matcher_version text not null,metadata jsonb not null default '{}',assigned_at timestamptz not null default now()
);
create index publisher_article_story_idx on public.publisher_article_story_assignments(story_id);

insert into public.feed_sources(id,publisher_id,url,feed_type) values
('abc-top','abc1','https://abcnews.go.com/abcnews/topstories','rss'),
('cbs-latest','cbs1','https://www.cbsnews.com/latest/rss/main','rss'),
('nbc-news','nbc1','https://feeds.nbcnews.com/nbcnews/public/news','rss'),
('cnn-top','cnn1','http://rss.cnn.com/rss/cnn_topstories.rss','rss'),
('guardian-us','guardian1','https://www.theguardian.com/us/rss','rss'),
('npr-news','npr1','https://feeds.npr.org/1001/rss.xml','rss'),
('bbc-news','bbc1','https://feeds.bbci.co.uk/news/rss.xml','rss'),
('fox-latest','fox1','https://moxie.foxnews.com/google-publisher/latest.xml','rss');

create function public.newsboard_save_feed_poll(p_feed_id text,p_started_at timestamptz,p_status integer,p_etag text,p_last_modified text,p_items jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare f public.feed_sources; x jsonb; stamp timestamptz:=now(); inserted_count int:=0; changed_count int:=0;
begin
 select * into strict f from public.feed_sources where id=p_feed_id and enabled for update;
 if p_status=304 then
  insert into public.feed_poll_runs(feed_id,started_at,http_status,not_modified) values(p_feed_id,p_started_at,304,true);
  update public.feed_sources set last_polled_at=stamp,last_success_at=stamp,last_error=null,http_status=304,updated_at=stamp where id=p_feed_id;
  return jsonb_build_object('inserted',0,'changed',0,'not_modified',true);
 end if;
 if p_status not between 200 and 299 or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>200 then raise exception 'Invalid feed result'; end if;
 for x in select value from jsonb_array_elements(p_items) loop
  if x->>'publisher_id' is distinct from f.publisher_id or x->>'feed_id' is distinct from f.id or length(coalesce(x->>'headline','')) not between 5 and 500 or coalesce(x->>'canonical_url','')!~'^https://' then raise exception 'Invalid feed item'; end if;
  insert into public.publisher_articles(publisher_id,canonical_url,original_feed_url,headline,description,published_at,modified_at,first_seen_at,last_seen_at,first_feed_id,last_feed_id,external_id,headline_norm,metadata)
  values(f.publisher_id,x->>'canonical_url',x->>'original_url',x->>'headline',nullif(x->>'description',''),nullif(x->>'published_at','')::timestamptz,nullif(x->>'modified_at','')::timestamptz,stamp,stamp,f.id,f.id,nullif(x->>'external_id',''),lower(regexp_replace(x->>'headline','[^[:alnum:]]+',' ','g')),jsonb_build_object('feed_type',f.feed_type))
  on conflict(publisher_id,canonical_url) do update set original_feed_url=excluded.original_feed_url,headline=excluded.headline,description=coalesce(excluded.description,publisher_articles.description),published_at=coalesce(publisher_articles.published_at,excluded.published_at),modified_at=coalesce(excluded.modified_at,publisher_articles.modified_at),last_seen_at=excluded.last_seen_at,last_feed_id=f.id,external_id=coalesce(excluded.external_id,publisher_articles.external_id),headline_norm=excluded.headline_norm,updated_at=case when publisher_articles.headline is distinct from excluded.headline or publisher_articles.description is distinct from excluded.description then stamp else publisher_articles.updated_at end;
  changed_count:=changed_count+1;
 end loop;
 insert into public.feed_poll_runs(feed_id,started_at,http_status,item_count) values(p_feed_id,p_started_at,p_status,jsonb_array_length(p_items));
 update public.feed_sources set etag=coalesce(p_etag,etag),last_modified=coalesce(p_last_modified,last_modified),last_polled_at=stamp,last_success_at=stamp,last_error=null,http_status=p_status,updated_at=stamp where id=p_feed_id;
 return jsonb_build_object('inserted',inserted_count,'updated',changed_count,'not_modified',false);
end $$;
create function public.newsboard_save_feed_failure(p_feed_id text,p_started_at timestamptz,p_error text,p_http_status integer default null) returns void language plpgsql security invoker set search_path='' as $$ begin
 insert into public.feed_poll_runs(feed_id,started_at,http_status,error) values(p_feed_id,p_started_at,p_http_status,left(p_error,1000));
 update public.feed_sources set last_polled_at=now(),last_error=left(p_error,1000),http_status=p_http_status,updated_at=now() where id=p_feed_id;
end $$;

-- A feed article is matched once. Its raw row remains independent and can be
-- reassigned after future matcher changes without fabricating promotion events.
create function public.newsboard_feed_story_inputs(p_limit int default 100) returns jsonb language sql security invoker set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(a) order by a.first_seen_at,a.id),'[]'::jsonb) from (select * from public.publisher_articles a where not exists(select 1 from public.publisher_article_story_assignments x where x.article_id=a.id) order by a.first_seen_at,a.id limit least(500,greatest(1,p_limit)))a;
$$;
create function public.newsboard_feed_story_commit(p_article uuid,p_story uuid,p_matcher_version text,p_metadata jsonb) returns boolean language plpgsql security invoker set search_path='' as $$
declare a public.publisher_articles;
begin select * into strict a from public.publisher_articles where id=p_article for update;
 if p_story is not null and not exists(select 1 from public.stories where id=p_story) then raise exception 'Feed evidence cannot create a Story Identity'; end if;
 insert into public.publisher_article_story_assignments(article_id,story_id,matcher_version,metadata) values(p_article,p_story,p_matcher_version,coalesce(p_metadata,'{}')) on conflict(article_id) do nothing;
 return found; end $$;

alter table public.feed_sources enable row level security; alter table public.publisher_articles enable row level security; alter table public.feed_poll_runs enable row level security; alter table public.publisher_article_story_assignments enable row level security;
revoke all on public.feed_sources,public.publisher_articles,public.feed_poll_runs,public.publisher_article_story_assignments from public,anon,authenticated;
grant all on public.feed_sources,public.publisher_articles,public.feed_poll_runs,public.publisher_article_story_assignments to service_role;
create policy service_access on public.feed_sources for all to service_role using(true) with check(true); create policy service_access on public.publisher_articles for all to service_role using(true) with check(true); create policy service_access on public.feed_poll_runs for all to service_role using(true) with check(true); create policy service_access on public.publisher_article_story_assignments for all to service_role using(true) with check(true);
revoke all on function public.newsboard_save_feed_poll(text,timestamptz,integer,text,text,jsonb),public.newsboard_save_feed_failure(text,timestamptz,text,integer),public.newsboard_feed_story_inputs(integer),public.newsboard_feed_story_commit(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.newsboard_save_feed_poll(text,timestamptz,integer,text,text,jsonb),public.newsboard_save_feed_failure(text,timestamptz,text,integer),public.newsboard_feed_story_inputs(integer),public.newsboard_feed_story_commit(uuid,uuid,text,jsonb) to service_role;

create or replace function public.newsboard_story_candidates(p_terms text[],p_at timestamptz,p_source text,p_urls text[])
returns jsonb language sql security invoker set search_path='' as $$
 with candidates as (select s.* from public.stories s where s.last_seen_at>=p_at-interval '48 hours' and s.first_detected_at<=p_at+interval '48 hours' and (s.search_terms&&p_terms or exists(select 1 from public.story_assignments a where a.story_id=s.id and a.source_id=p_source and a.url=any(p_urls)) or exists(select 1 from public.publisher_article_story_assignments fa join public.publisher_articles pa on pa.id=fa.article_id where fa.story_id=s.id and pa.publisher_id=p_source and pa.canonical_url=any(p_urls))) order by (select count(*) from unnest(s.search_terms)t where t=any(p_terms)) desc,s.last_seen_at desc limit 100)
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'first_detected_at',s.first_detected_at,'last_seen_at',s.last_seen_at,'representatives',coalesce((select jsonb_agg(x) from (select a.source_id,a.headline title,a.url,a.observed_at,a.metadata#>>'{input_evidence,description}' description from public.story_assignments a where a.story_id=s.id and a.observed_at between p_at-interval '48 hours' and p_at+interval '48 hours' union all select pa.publisher_id,pa.headline,pa.canonical_url,pa.first_seen_at,pa.description from public.publisher_article_story_assignments fa join public.publisher_articles pa on pa.id=fa.article_id where fa.story_id=s.id and pa.first_seen_at between p_at-interval '48 hours' and p_at+interval '48 hours' limit 24)x),'[]'))),'[]') from candidates s;
$$;

create function newsboard_private.invoke_feed_discovery() returns bigint language plpgsql security invoker set search_path='' as $$ declare token text; begin select decrypted_secret into strict token from vault.decrypted_secrets where name='newsboard_crawl_token'; return net.http_post(url:='https://aknclkofrjliaecsjbnp.supabase.co/functions/v1/feed-discovery',headers:=jsonb_build_object('Content-Type','application/json','x-newsboard-token',token),body:='{}',timeout_milliseconds:=120000); end $$;
revoke all on function newsboard_private.invoke_feed_discovery() from public,anon,authenticated;
select cron.schedule('newsboard-feed-discovery','3-59/15 * * * *',$cron$select newsboard_private.invoke_feed_discovery();$cron$);
notify pgrst,'reload schema';
