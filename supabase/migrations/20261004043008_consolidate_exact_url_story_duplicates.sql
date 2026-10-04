-- Drain duplicate singleton identities conservatively. Only an exact latest
-- normalized headline, publisher, and canonical URL match is eligible. This
-- deliberately excludes rolling/live URLs whose topic has changed.
create function public.newsboard_story_consolidate_exact_duplicates(
  p_limit integer default 12,
  p_recent integer default 7
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  candidate record;
  merged_count integer := 0;
  failed_count integer := 0;
  failures jsonb := '[]'::jsonb;
begin
  if p_limit < 1 or p_limit > 50 then
    raise exception 'Cleanup limit must be between 1 and 50';
  end if;
  if p_recent < 1 or p_recent > 30 then
    raise exception 'Recent window must be between 1 and 30 days';
  end if;

  perform pg_advisory_xact_lock(794613);
  for candidate in
    with recent_singletons as (
      select
        s.id as story_id,
        s.first_detected_at,
        s.last_seen_at,
        latest.source_id,
        latest.url,
        latest.headline_norm
      from public.stories s
      join lateral (
        select a.source_id, a.url, a.headline_norm
        from public.story_assignments a
        where a.story_id = s.id
        order by a.observed_at desc, a.batch_key desc, a.rank
        limit 1
      ) latest on true
      where s.last_seen_at >= now() - make_interval(days => p_recent)
        and latest.url is not null
        and latest.url <> ''
        and latest.headline_norm is not null
        and latest.headline_norm <> ''
        and (select count(distinct m.source_id)
             from public.story_members m where m.story_id = s.id) = 1
    ), ranked as (
      select r.*,
        first_value(r.story_id) over (
          partition by r.source_id, r.url, r.headline_norm
          order by r.first_detected_at, r.story_id
        ) as target_story_id,
        row_number() over (
          partition by r.source_id, r.url, r.headline_norm
          order by r.first_detected_at, r.story_id
        ) as identity_rank
      from recent_singletons r
    )
    select story_id as source_story_id, target_story_id
    from ranked
    where identity_rank > 1
    order by last_seen_at desc, story_id
    limit p_limit
  loop
    begin
      perform public.newsboard_story_merge(
        candidate.source_story_id,
        candidate.target_story_id,
        'Automatic exact publisher URL and normalized headline consolidation',
        'story-intelligence-exact-continuity'
      );
      update public.story_assignments
      set metadata = metadata
        - 'manual_correction'
        - 'manual_merge_source_story_id'
        - 'manual_target_story_id'
        - 'manual_reviewer'
        - 'manual_corrected_at'
        || jsonb_build_object(
          'automatic_exact_continuity_merge', true,
          'automatic_merge_source_story_id', candidate.source_story_id,
          'automatic_target_story_id', candidate.target_story_id,
          'automatic_matcher_version', 'deterministic-v2',
          'automatic_merged_at', now()
        )
      where story_id = candidate.target_story_id
        and metadata ->> 'manual_merge_source_story_id' = candidate.source_story_id::text;
      merged_count := merged_count + 1;
    exception when others then
      failed_count := failed_count + 1;
      failures := failures || jsonb_build_array(jsonb_build_object(
        'source_story_id', candidate.source_story_id,
        'target_story_id', candidate.target_story_id,
        'error', left(sqlerrm, 300)
      ));
    end;
  end loop;

  return jsonb_build_object(
    'merged', merged_count,
    'failed', failed_count,
    'recent_days', p_recent,
    'failures', failures
  );
end;
$$;

revoke all on function public.newsboard_story_consolidate_exact_duplicates(integer,integer)
from public, anon, authenticated;
grant execute on function public.newsboard_story_consolidate_exact_duplicates(integer,integer)
to service_role;

notify pgrst, 'reload schema';
