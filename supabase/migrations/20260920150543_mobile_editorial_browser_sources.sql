-- Data-only routing change. The existing browser worker uses the same start,
-- save and finish RPCs/tables. No schema or scheduler changes are needed.
update public.crawler_publishers
set method = 'browser',
    reason = 'Rendered mobile homepage is authoritative; collected by existing browser worker'
where source_id in ('ap1', 'usat1', 'nbc1', 'yahoo1', 'guardian1');
