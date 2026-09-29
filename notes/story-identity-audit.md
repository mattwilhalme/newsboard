# Story Identity audit

The audit ledger evaluates Story Intelligence without changing automated assignments.

Required server-side environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- optional `NEWSBOARD_AUDIT_REVIEWER`

List up to 200 recent assignments and unprocessed batches:

```bash
npm run story:audit -- list 200
```

Record a verdict:

```bash
npm run story:audit -- record STORY_UUID correct "Observations describe one event"
```

Inspect one identity or the correction ledger:

```bash
npm run story:audit -- show STORY_UUID
npm run story:audit -- corrections 100
```

Move an article (all stored and future observations for the same publisher and canonical URL) to an existing identity, or create a new manual identity from it:

```bash
npm run story:audit -- reassign SNAPSHOT_BATCH_KEY RANK TARGET_STORY_UUID "Reason for correction"
npm run story:audit -- create SNAPSHOT_BATCH_KEY RANK "New identity label" "Reason for correction"
```

Corrections require the service-role credential, append a private correction ledger, and rebuild affected derived stories transactionally. Raw crawler snapshots are unchanged. Active correction rules are applied by the Story Intelligence worker to future observations of the same publisher/article URL, so public Story Radar and Story History reads remain corrected.

Allowed verdicts are `correct`, `false_merge`, `false_split`, `uncertain`, and
`missing_observation`. Audit rows are private, append-only evaluation evidence;
they do not rewrite stories, members, assignments, or matcher behavior.

Review 100–200 identities across breaking news, live blogs, rolling URLs,
headline rewrites, and similar-but-distinct events before tuning the matcher.
