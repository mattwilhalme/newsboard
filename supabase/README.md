# Newsboard Supabase

The primary crawler is the `newsboard-crawl` Edge Function, invoked by one Supabase Cron job every five minutes. Seven HTTP publishers are enabled; the other five are scheduled through the [targeted GitHub browser workflow](../notes/browser-gap-fill.md). The full manual browser backup remains available.

See [the migration report](../notes/crawler-migration.md) for architecture, applied migrations, publisher comparisons, public read RPCs, security, health queries, manual invocation and rollback.

The migration files match remote migration-history versions. They repair and extend the existing project and do not constitute a full schema baseline for an empty database.
