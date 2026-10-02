-- Keep public read RPCs below the API statement timeout as their ledgers grow.
create index if not exists hero_runs_source_observed_success_idx
  on public.hero_runs(source_id, observed_at desc)
  where ok and url is not null;
create index if not exists hero_runs_source_story_success_idx
  on public.hero_runs(source_id, url, title, observed_at)
  where ok and url is not null;
create index if not exists story_members_active_seen_story_idx
  on public.story_members(last_seen_at desc, story_id)
  include(source_id, url, latest_headline)
  where active;

create or replace function public.newsboard_snapshot() returns jsonb
language sql stable security invoker set search_path='' as $$
with current_payload as (
  select jsonb_object_agg(p.source_id,jsonb_build_object(
    'ok',c.source_id is not null,'updatedAt',c.observed_at,'updated_at',c.observed_at,
    'firstSeenAt',c.first_seen_at,'lastChangeAt',c.last_change_at,'sourceName',s.name,
    'kind',s.kind,'homeUrl',s.home_url,'item',c.item,
    'items',case when s.kind='discovery' then c.items else null end,
    'health',jsonb_build_object(
      'crawlStatus',cs.crawl_status,'definitiveFailure',cs.crawl_status='failed',
      'lastAttemptSuccess',case when cs.crawl_status='success' then true when cs.crawl_status='failed' then false else null end,
      'lastSuccessfulCrawlAt',c.observed_at,'lastAttemptAt',cs.last_attempt_at,
      'lastFailureAt',cs.last_failure_at,'lastHeadlineChangeAt',c.last_change_at,
      'latestError',cs.error,'method',p.method,'browserFallbackAvailable',p.browser_fallback_enabled,
      'primaryAttempt',jsonb_build_object('status',cs.primary_status,'completedAt',cs.primary_attempt_at,'success',cs.primary_success,'error',cs.primary_error),
      'browserAttempt',jsonb_build_object('status',cs.browser_status,'requestedAt',cs.browser_requested_at,'startedAt',cs.browser_started_at,'completedAt',cs.browser_completed_at)))) payload
  from public.crawler_publishers p
  join public.sources s on s.id=p.source_id
  left join public.crawler_current c on c.source_id=p.source_id
  left join public.v_crawler_attempt_status cs on cs.source_id=p.source_id
), history_payload as (
  select jsonb_object_agg(s.id,jsonb_build_object('entries',coalesce(h.entries,'[]'::jsonb))) payload
  from public.sources s
  left join public.crawler_current c on c.source_id=s.id
  left join lateral (
    with story_keys as materialized (
      select distinct r.title,r.url from public.hero_runs r
      where r.source_id=s.id and r.ok and r.url is not null
        and (r.observed_at>now()-interval '7 days' or r.url=(c.item->>'url'))
    ), grouped as (
      select r.title,r.url,min(r.observed_at) first_seen,max(r.observed_at) last_seen,count(*) seen
      from story_keys k
      join public.hero_runs r on r.source_id=s.id and r.title=k.title and r.url=k.url and r.ok
      group by r.title,r.url
    )
    select jsonb_agg(jsonb_build_object('title',title,'url',url,'firstSeenAt',first_seen,'lastSeenAt',last_seen,'seenCount',seen) order by last_seen) entries
    from grouped
  ) h on true
)
select jsonb_build_object(
  'cacheLike',jsonb_build_object('generatedAt',now(),'sources',coalesce((select payload from current_payload),'{}'::jsonb)),
  'history',jsonb_build_object('generatedAt',now(),'sources',coalesce((select payload from history_payload),'{}'::jsonb))
);
$$;

create or replace function public.newsboard_story_badges() returns jsonb
language sql stable security invoker set search_path='' as $$
with active_members as materialized (
  select story_id,source_id,url,latest_headline
  from public.story_members
  where active and last_seen_at>now()-interval '2 hours'
), counts as (
  select story_id,count(*) n from active_members group by story_id having count(*)>1
)
select coalesce(jsonb_agg(jsonb_build_object(
  'story_id',s.id,'source_id',m.source_id,'url',m.url,'title',m.latest_headline,
  'first_source_id',s.first_source_id,'publisher_count',c.n,'first_detected_at',s.first_detected_at
)),'[]'::jsonb)
from counts c
join active_members m on m.story_id=c.story_id
join public.stories s on s.id=c.story_id;
$$;

create or replace function public.newsboard_top10(p_hours int default 168) returns jsonb
language sql stable security invoker set search_path='' as $$
with selected_runs as materialized (
  select r.id,r.observed_at,r.ok,r.source_id
  from public.top10_runs r
  where r.source_id='abc1' and r.ok
    and r.observed_at>now()-make_interval(hours=>least(168,greatest(1,p_hours)))
  order by r.observed_at desc
  limit 2016
), item_payloads as materialized (
  select i.run_id,jsonb_agg(jsonb_build_object(
    'rank',i.rank,'title',i.title,'url',i.url,'fingerprint',i.fingerprint,
    'related_links',i.related_links
  ) order by i.rank) items
  from public.top10_items i join selected_runs r on r.id=i.run_id
  group by i.run_id
), runs as materialized (
  select r.id,r.observed_at,jsonb_build_object(
    'ok',r.ok,'source_id',r.source_id,'observedAt',r.observed_at,'runId',r.id,
    'items',coalesce(i.items,'[]'::jsonb)
  ) payload
  from selected_runs r left join item_payloads i on i.run_id=r.id
)
select jsonb_build_object(
  'latest',(select payload from runs order by observed_at desc limit 1),
  'runs',coalesce((select jsonb_agg(payload order by observed_at) from runs),'[]'::jsonb),
  'events',coalesce((select jsonb_agg(e order by e.observed_at) from (
    select * from public.top10_events
    where source_id='abc1'
      and observed_at>now()-make_interval(hours=>least(168,greatest(1,p_hours)))
    order by observed_at desc limit 3000
  ) e),'[]'::jsonb)
);
$$;
