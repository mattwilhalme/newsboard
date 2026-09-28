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

Allowed verdicts are `correct`, `false_merge`, `false_split`, `uncertain`, and
`missing_observation`. Audit rows are private, append-only evaluation evidence;
they do not rewrite stories, members, assignments, or matcher behavior.

Review 100–200 identities across breaking news, live blogs, rolling URLs,
headline rewrites, and similar-but-distinct events before tuning the matcher.
