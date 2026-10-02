-- The frontend consumes runs and latest only. Timeline events have their own
-- bounded RPC, so serializing them again here wastes most of the read budget.
create or replace function public.newsboard_top10(p_hours int default 168) returns jsonb
language sql stable security invoker set search_path='' as $$
with selected_runs as materialized (
  select r.id,r.observed_at,r.ok,r.source_id
  from public.top10_runs r
  where r.source_id='abc1' and r.ok
    and r.observed_at>now()-make_interval(hours=>least(168,greatest(1,p_hours)))
  order by r.observed_at desc
  limit 2016
), latest_run as (
  select id from selected_runs order by observed_at desc limit 1
), item_payloads as materialized (
  select i.run_id,jsonb_agg(
    jsonb_build_object('rank',i.rank,'title',i.title,'url',i.url,'fingerprint',i.fingerprint)
    || case when i.run_id=(select id from latest_run)
      then jsonb_build_object('related_links',i.related_links)
      else '{}'::jsonb end
    order by i.rank
  ) items
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
  'events','[]'::jsonb
);
$$;
