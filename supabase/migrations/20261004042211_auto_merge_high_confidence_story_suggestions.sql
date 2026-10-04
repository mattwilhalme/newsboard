-- Promote only the strongest queued singleton matches automatically. Lower
-- confidence qualifying pairs remain available to the editorial review UI.
create function public.newsboard_story_auto_merge_suggestions(
  p_limit integer default 8,
  p_min_score numeric default 0.84
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  candidate record;
  source_id uuid;
  target_id uuid;
  used_ids uuid[] := '{}';
  merged_count integer := 0;
  failed_count integer := 0;
  failures jsonb := '[]'::jsonb;
  merge_result jsonb;
begin
  if p_min_score < 0.75 or p_min_score > 1 then
    raise exception 'Auto-merge score must be between 0.75 and 1';
  end if;

  for candidate in
    select q.*
    from newsboard_private.story_match_suggestions q
    where q.status = 'pending'
      and q.score >= p_min_score
      and exists (
        select 1 from public.story_members m where m.story_id = q.story_a
        group by m.story_id having count(distinct m.source_id) = 1
      )
      and exists (
        select 1 from public.story_members m where m.story_id = q.story_b
        group by m.story_id having count(distinct m.source_id) = 1
      )
    order by q.score desc, q.last_scored_at desc
    limit least(25, greatest(1, p_limit))
    for update skip locked
  loop
    if candidate.story_a = any(used_ids) or candidate.story_b = any(used_ids) then
      continue;
    end if;
    source_id := nullif(candidate.evidence ->> 'source_story_id', '')::uuid;
    target_id := nullif(candidate.evidence ->> 'target_story_id', '')::uuid;
    if source_id is null or target_id is null
       or not (source_id in (candidate.story_a, candidate.story_b))
       or not (target_id in (candidate.story_a, candidate.story_b))
       or source_id = target_id then
      continue;
    end if;

    begin
      merge_result := public.newsboard_story_merge(
        source_id,
        target_id,
        'Automatic high-confidence matcher suggestion',
        'story-intelligence-auto'
      );
      update public.story_assignments
      set metadata = metadata
        - 'manual_correction'
        - 'manual_merge_source_story_id'
        - 'manual_target_story_id'
        - 'manual_reviewer'
        - 'manual_corrected_at'
        || jsonb_build_object(
          'automatic_suggestion_merge', true,
          'automatic_merge_source_story_id', source_id,
          'automatic_target_story_id', target_id,
          'automatic_matcher_version', candidate.matcher_version,
          'automatic_match_score', candidate.score,
          'automatic_merged_at', now()
        )
      where story_id = target_id
        and metadata ->> 'manual_merge_source_story_id' = source_id::text;
      insert into newsboard_private.story_match_decisions(
        story_a, story_b, decision, matcher_version, score, evidence, reviewer
      ) values (
        source_id, target_id, 'merge', candidate.matcher_version,
        candidate.score, candidate.evidence, 'story-intelligence-auto'
      );
      update newsboard_private.story_match_suggestions
      set status = 'merged', reviewed_at = now(), reviewer = 'story-intelligence-auto'
      where story_a = candidate.story_a and story_b = candidate.story_b;
      used_ids := array_append(array_append(used_ids, source_id), target_id);
      merged_count := merged_count + 1;
    exception when others then
      failed_count := failed_count + 1;
      failures := failures || jsonb_build_array(jsonb_build_object(
        'story_a', candidate.story_a,
        'story_b', candidate.story_b,
        'error', left(sqlerrm, 300)
      ));
    end;
  end loop;

  return jsonb_build_object(
    'merged', merged_count,
    'failed', failed_count,
    'minimum_score', p_min_score,
    'failures', failures
  );
end;
$$;

revoke all on function public.newsboard_story_auto_merge_suggestions(integer,numeric)
from public, anon, authenticated;
grant execute on function public.newsboard_story_auto_merge_suggestions(integer,numeric)
to service_role;

notify pgrst, 'reload schema';
