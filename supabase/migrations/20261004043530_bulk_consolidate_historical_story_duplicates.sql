-- Maintenance-only compactor for the historical backlog. It applies the same
-- conservative exact publisher + canonical URL + normalized headline rule as
-- the incremental worker, but moves a whole duplicate group before rebuilding
-- its target once. This makes large historical groups tractable and auditable.
create function public.newsboard_story_compact_exact_duplicate_groups(
  p_group_limit integer default 12
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  candidate record;
  merge_source_id uuid;
  groups_merged integer := 0;
  identities_merged integer := 0;
  failed_count integer := 0;
  failures jsonb := '[]'::jsonb;
  oldest_headline text;
begin
  if p_group_limit < 1 or p_group_limit > 25 then
    raise exception 'Group limit must be between 1 and 25';
  end if;

  perform pg_advisory_xact_lock(794614);
  for candidate in
    with singleton_keys as (
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
      where latest.url is not null and latest.url <> ''
        and latest.headline_norm is not null and latest.headline_norm <> ''
        and (select count(distinct m.source_id)
             from public.story_members m where m.story_id = s.id) = 1
    ), duplicate_groups as (
      select
        source_id,
        url,
        headline_norm,
        (array_agg(story_id order by first_detected_at, story_id))[1] as target_story_id,
        (array_agg(story_id order by first_detected_at, story_id))[2:] as source_story_ids,
        max(last_seen_at) as newest_at,
        count(*) as identity_count
      from singleton_keys
      group by source_id, url, headline_norm
      having count(*) > 1
    )
    select * from duplicate_groups
    order by newest_at desc, identity_count desc, source_id, url
    limit p_group_limit
  loop
    begin
      update newsboard_private.story_identity_corrections c
      set active = false, superseded_at = now()
      where c.active
        and c.source_id = candidate.source_id
        and c.canonical_url = candidate.url;

      insert into newsboard_private.story_identity_corrections(
        source_id, canonical_url, target_story_id, previous_story_ids,
        action, notes, reviewer
      ) values (
        candidate.source_id, candidate.url, candidate.target_story_id,
        candidate.source_story_ids, 'reassign',
        'Bulk automatic exact publisher URL and normalized headline consolidation',
        'story-intelligence-history-compactor'
      );

      foreach merge_source_id in array candidate.source_story_ids loop
        insert into newsboard_private.story_group_merges(
          source_story_id, target_story_id, source_label, target_label,
          assignments_moved, notes, reviewer
        )
        select
          merge_source_id,
          candidate.target_story_id,
          coalesce(src.manual_label, src.canonical_label),
          coalesce(dst.manual_label, dst.canonical_label),
          (select count(*) from public.story_assignments a where a.story_id = merge_source_id),
          'Bulk automatic exact publisher URL and normalized headline consolidation',
          'story-intelligence-history-compactor'
        from public.stories src
        cross join public.stories dst
        where src.id = merge_source_id and dst.id = candidate.target_story_id;
      end loop;

      update public.story_assignments
      set metadata = metadata || jsonb_build_object(
          'automatic_exact_continuity_merge', true,
          'automatic_merge_source_story_id', story_id,
          'automatic_target_story_id', candidate.target_story_id,
          'automatic_matcher_version', 'deterministic-v2',
          'automatic_merged_at', now(),
          'automatic_historical_compaction', true
        ),
        story_id = candidate.target_story_id
      where story_id = any(candidate.source_story_ids);

      delete from public.stories
      where id = any(candidate.source_story_ids);

      select headline into strict oldest_headline
      from public.story_assignments
      where story_id = candidate.target_story_id
      order by observed_at, source_id, batch_key, rank
      limit 1;
      update public.stories
      set canonical_label = oldest_headline
      where id = candidate.target_story_id;
      perform public.newsboard_story_rebuild(candidate.target_story_id);

      groups_merged := groups_merged + 1;
      identities_merged := identities_merged + cardinality(candidate.source_story_ids);
    exception when others then
      failed_count := failed_count + 1;
      failures := failures || jsonb_build_array(jsonb_build_object(
        'source_id', candidate.source_id,
        'url', candidate.url,
        'target_story_id', candidate.target_story_id,
        'error', left(sqlerrm, 300)
      ));
    end;
  end loop;

  return jsonb_build_object(
    'groups_merged', groups_merged,
    'identities_merged', identities_merged,
    'failed', failed_count,
    'failures', failures
  );
end;
$$;

revoke all on function public.newsboard_story_compact_exact_duplicate_groups(integer)
from public, anon, authenticated;
grant execute on function public.newsboard_story_compact_exact_duplicate_groups(integer)
to service_role;

notify pgrst, 'reload schema';
