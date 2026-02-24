create index if not exists idx_screenshot_created_at
on public.screenshot_events (created_at desc);
