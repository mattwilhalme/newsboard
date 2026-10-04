# Publisher feed discovery

Feed discovery is publication evidence only. It writes deduplicated `publisher_articles` and derived `publisher_article_story_assignments`; it never writes crawler snapshots, hero runs, Top 10 data, homepage assignments, or promotion events. The independent worker runs every 15 minutes, uses conditional requests, caps responses at 2 MB, bounds concurrency, and isolates failures per feed.

| Publisher | Feed | Type | Usable | Limitations |
|---|---|---:|---:|---|
| ABC News | `https://abcnews.go.com/abcnews/topstories` | RSS | yes | Top stories only. |
| CBS News | `https://www.cbsnews.com/latest/rss/main` | RSS | yes | General/latest; topic feeds exist. |
| NBC News | `https://feeds.nbcnews.com/nbcnews/public/news` | RSS | yes | General selection. |
| CNN | `http://rss.cnn.com/rss/cnn_topstories.rss` | RSS | yes | Legacy HTTP; redirects followed. |
| The Guardian | `https://www.theguardian.com/us/rss` | RSS | yes | US front; section feeds broaden coverage. |
| NPR | `https://feeds.npr.org/1001/rss.xml` | RSS | yes | News topic; many topic feeds exist. |
| BBC | `https://feeds.bbci.co.uk/news/rss.xml` | RSS | yes | General news; section feeds exist. |
| Fox News | `https://moxie.foxnews.com/google-publisher/latest.xml` | RSS | yes | Latest, not homepage ranking. |
| USA Today | — | — | no | Externally hosted common endpoint omitted pending official confirmation. |
| Los Angeles Times | — | — | no | Multiple section feeds likely required. |
| Yahoo News | — | — | no | No reliable official general feed verified. |
| Associated Press | existing Google News discovery | RSS | separate | `apgoogle1` remains separate. |

Rows are unique on `(publisher_id, canonical_url)`; repeated polls update one row. `feed_poll_runs` adds about 768 rows/day. Existing crawler snapshots/source runs, Top 10 runs/items, dispatches, story processing runs, and the new poll table lack automatic time retention. Ranked observations were already flagged as a 30–90 day retention candidate in `notes/multi-publisher-top10.md`; no cleanup is done here.

Publisher `published_at`, feed `first_seen_at`, homepage detection, first ranked appearance, and first #1 remain distinct.
