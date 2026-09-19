-- During parallel validation, keep existing server.js writes visible in the new read model.
create function public.newsboard_sync_legacy_hero() returns trigger language plpgsql set search_path='' as $$
begin
 if not new.ok or coalesce(new.title,'')='' or coalesce(new.url,'')='' then return new; end if;
 insert into public.crawler_current(source_id,observed_at,item,items,first_seen_at,last_change_at)
 values(new.source_id,new.observed_at,jsonb_build_object('title',new.title,'url',new.url,'imgUrl',new.img_url,'contentType',new.raw->>'content_type','breakingLabel',new.raw->>'breaking_label','breakingHeadline',new.raw->>'breaking_headline','breakingUrl',new.raw->>'breaking_url'),jsonb_build_array(jsonb_build_object('rank',1,'title',new.title,'url',new.url,'slot_key','hero:1')),new.observed_at,new.observed_at)
 on conflict(source_id) do update set observed_at=excluded.observed_at,item=excluded.item,items=excluded.items,first_seen_at=case when crawler_current.item->>'url'=new.url then crawler_current.first_seen_at else new.observed_at end,last_change_at=case when crawler_current.item->>'url'=new.url and crawler_current.item->>'title'=new.title then crawler_current.last_change_at else new.observed_at end where excluded.observed_at>crawler_current.observed_at;
 return new;
end $$;
revoke all on function public.newsboard_sync_legacy_hero() from public,anon,authenticated;
create trigger newsboard_legacy_hero after insert on public.hero_runs for each row execute function public.newsboard_sync_legacy_hero();
