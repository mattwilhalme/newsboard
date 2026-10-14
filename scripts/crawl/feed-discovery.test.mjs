import assert from 'node:assert/strict';
import test from 'node:test';
import {fetchFeed,normalizeArticleUrl,parseFeed} from '../../supabase/functions/_shared/feed-discovery.js';
import {buildLiveBlogDiscoveryPayload,isLiveBlogUrl,notifyLiveBlogDiscovery} from '../../supabase/functions/_shared/live-blog-discovery.js';
const rss=`<rss><channel><item><title>First meaningful headline</title><link>http://www.example.com/news/a/?utm_source=rss#x</link><description>A useful deck</description><pubDate>Sun, 04 Oct 2026 17:00:00 GMT</pubDate></item><item><title>Duplicate headline</title><link>https://example.com/news/a</link></item><item><title>Broken item has no URL</title></item></channel></rss>`;
const atom=`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:1</id><title>Atom article headline</title><link rel="alternate" href="https://example.com/b?gclid=x"/><summary>Atom deck</summary><published>2026-10-04T16:00:00Z</published><updated>2026-10-04T16:05:00Z</updated></entry></feed>`;
test('normalizes URLs',()=>assert.equal(normalizeArticleUrl('http://WWW.Example.com/a/?utm_medium=x&id=2#top'),'https://example.com/a?id=2'));
test('parses and deduplicates RSS while isolating malformed entries',()=>{const x=parseFeed(rss,{feedId:'f',publisherId:'p'});assert.equal(x.items.length,1);assert.equal(x.items[0].published_at,'2026-10-04T17:00:00.000Z');assert.equal(x.items[0].description,'A useful deck');});
test('parses Atom timestamps',()=>{const x=parseFeed(atom).items[0];assert.equal(x.canonical_url,'https://example.com/b');assert.equal(x.modified_at,'2026-10-04T16:05:00.000Z');});
test('rejects malformed feeds',()=>assert.throws(()=>parseFeed('<rss><channel/></rss>'),/no entries/));
test('handles HTTP failure and 304',async()=>{await assert.rejects(()=>fetchFeed({id:'f',publisherId:'p',url:'https://example.com'}, {}, {fetchImpl:async()=>new Response('',{status:503})}),/503/);let sent;const x=await fetchFeed({id:'f',publisherId:'p',url:'https://example.com'},{etag:'"v1"'},{fetchImpl:async(_u,o)=>{sent=o.headers;return new Response(null,{status:304});}});assert.equal(sent['if-none-match'],'"v1"');assert.equal(x.notModified,true);});
test('consecutive polls retain identity and permit metadata updates',()=>{const a=parseFeed(rss).items[0],b=parseFeed(rss.replace('First meaningful headline','Updated meaningful headline')).items[0];assert.equal(a.canonical_url,b.canonical_url);assert.notEqual(a.headline,b.headline);});
test('feed items contain no homepage or rank evidence',()=>{const x=parseFeed(rss).items[0];assert.equal('rank' in x,false);assert.equal('coverage_scope' in x,false);});
test('live-blog discovery recognizes only supported publisher URL shapes',()=>{
 assert.equal(isLiveBlogUrl('abc1','https://abcnews.com/International/live-updates/iran?id=1'),true);
 assert.equal(isLiveBlogUrl('cnn1','https://cnn.com/weather/live-news/storm'),true);
 assert.equal(isLiveBlogUrl('nbc1','https://nbcnews.com/news/live-blog/example-rcna123'),true);
 assert.equal(isLiveBlogUrl('abc1','https://abcnews.com/Live/'),false);
 assert.equal(isLiveBlogUrl('fox1','https://foxnews.com/live-news/example'),false);
});
test('builds the signed-receiver schema and omits ordinary stories',()=>{
 const payload=buildLiveBlogDiscoveryPayload({channel:'top10',sourceId:'cbs1',observedAt:'2026-10-14T04:00:00Z',runId:'run-1',items:[{rank:2,title:'Live coverage',url:'https://www.cbsnews.com/texas/live-updates/flooding/',fingerprint:'abc'},{rank:3,title:'Ordinary story',url:'https://www.cbsnews.com/news/story/'}]});
 assert.equal(payload.schema_version,1);assert.equal(payload.items.length,1);assert.equal(payload.items[0].rank,2);assert.equal(payload.items[0].source_id,'cbs1');
});
test('does not call the receiver without candidates or a server-side secret',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return new Response('{}');};
 assert.equal((await notifyLiveBlogDiscovery({channel:'feed',sourceId:'abc1',items:[]},{secret:'secret',fetchImpl})).status,'skipped');
 assert.equal((await notifyLiveBlogDiscovery({channel:'feed',sourceId:'abc1',items:[{headline:'Live',canonical_url:'https://abcnews.com/US/live-updates/event'}]},{fetchImpl})).reason,'missing_discovery_secret');
 assert.equal(calls,0);
});
