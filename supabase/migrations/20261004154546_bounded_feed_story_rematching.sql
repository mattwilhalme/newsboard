alter table public.publisher_article_story_assignments
  add column attempt_count integer not null default 1 check(attempt_count between 1 and 8),
  add column last_attempted_at timestamptz not null default now(),
  add column next_attempt_at timestamptz,
  add column matched_at timestamptz;

-- Existing unmatched rows receive one immediate reconsideration now that a
-- later homepage observation may have created a viable Story Identity.
update public.publisher_article_story_assignments
set next_attempt_at = now()
where story_id is null;
update public.publisher_article_story_assignments
set matched_at = assigned_at
where story_id is not null;

create index publisher_article_story_retry_idx
  on public.publisher_article_story_assignments(next_attempt_at, attempt_count)
  where story_id is null;

create or replace function public.newsboard_feed_story_inputs(p_limit integer default 100)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(q) order by q.retry, q.first_seen_at, q.id), '[]'::jsonb)
  from (
    select
      a.*,
      coalesce(x.attempt_count, 0) as previous_attempts,
      (x.article_id is not null) as retry
    from public.publisher_articles a
    left join public.publisher_article_story_assignments x on x.article_id = a.id
    where a.first_seen_at >= now() - interval '72 hours'
      and (
        x.article_id is null
        or (
          x.story_id is null
          and x.attempt_count < 8
          and (
            x.next_attempt_at <= now()
            or a.updated_at > x.last_attempted_at
          )
        )
      )
    order by (x.article_id is not null), a.first_seen_at, a.id
    limit least(200, greatest(1, p_limit))
  ) q;
$$;

create or replace function public.newsboard_feed_story_commit(
  p_article uuid,
  p_story uuid,
  p_matcher_version text,
  p_metadata jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  a public.publisher_articles;
begin
  select * into strict a
  from public.publisher_articles
  where id = p_article
  for update;

  if p_story is not null
     and not exists(select 1 from public.stories where id = p_story) then
    raise exception 'Feed evidence cannot create a Story Identity';
  end if;

  insert into public.publisher_article_story_assignments(
    article_id, story_id, matcher_version, metadata, attempt_count,
    last_attempted_at, next_attempt_at, matched_at
  ) values (
    p_article, p_story, p_matcher_version, coalesce(p_metadata, '{}'), 1,
    now(), case when p_story is null then now() + interval '15 minutes' end,
    case when p_story is not null then now() end
  )
  on conflict(article_id) do update set
    story_id = excluded.story_id,
    matcher_version = excluded.matcher_version,
    metadata = excluded.metadata,
    attempt_count = case
      when a.updated_at > publisher_article_story_assignments.last_attempted_at then 1
      else least(8, publisher_article_story_assignments.attempt_count + 1)
    end,
    last_attempted_at = now(),
    next_attempt_at = case
      when excluded.story_id is not null then null
      else now() + make_interval(mins => (15 * power(2, least(5,
        case when a.updated_at > publisher_article_story_assignments.last_attempted_at
          then 0 else publisher_article_story_assignments.attempt_count end
      )))::integer)
    end,
    matched_at = case when excluded.story_id is not null then now() else null end
  where publisher_article_story_assignments.story_id is null;

  return found;
end;
$$;

create function public.newsboard_feed_effectiveness(p_hours integer default 24)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with bounds as (
    select now() - make_interval(hours => least(168, greatest(1, p_hours))) as since
  ), per_publisher as (
    select
      s.id as publisher_id,
      s.name as publisher,
      count(a.id) as discovered,
      count(x.story_id) as matched,
      count(a.id) filter(where x.article_id is null) as awaiting_first_attempt,
      count(a.id) filter(where x.story_id is null and x.attempt_count < 8 and x.next_attempt_at is not null) as retry_pending,
      count(a.id) filter(where x.story_id is null and x.attempt_count >= 8) as retry_exhausted,
      round(100.0 * count(x.story_id) / nullif(count(a.id), 0), 1) as match_rate_percent,
      round(avg(extract(epoch from (a.first_seen_at - a.published_at))) filter(where a.published_at is not null) / 60.0, 1) as average_discovery_delay_minutes,
      max(a.first_seen_at) as latest_discovery_at,
      max(x.matched_at) as latest_match_at
    from public.sources s
    join public.feed_sources f on f.publisher_id = s.id and f.enabled
    cross join bounds b
    left join public.publisher_articles a on a.publisher_id = s.id and a.first_seen_at >= b.since
    left join public.publisher_article_story_assignments x on x.article_id = a.id
    group by s.id, s.name
  )
  select jsonb_build_object(
    'hours', least(168, greatest(1, p_hours)),
    'generated_at', now(),
    'publishers', coalesce(jsonb_agg(to_jsonb(per_publisher) order by publisher), '[]'::jsonb)
  )
  from per_publisher;
$$;

-- Operational aggregate: keep service-role-only because invoker security must
-- not become a reason to expose the underlying raw feed tables through RLS.
revoke all on function public.newsboard_feed_effectiveness(integer) from public, anon, authenticated;
grant execute on function public.newsboard_feed_effectiveness(integer) to service_role;
notify pgrst, 'reload schema';
