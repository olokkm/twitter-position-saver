#!/usr/bin/env node
/**
 * Unit tests for ListLatestTweetsTimeline cursor encode/decode + snowflake helpers
 * and the Top→Bottom fill-up rewrite math. Duplicates pure helpers from the userscript.
 */

const TWITTER_EPOCH_MS = 1288834974657n;
const DEFAULT_FILL_DELTA = BigInt(3 * 60 * 60 * 1000) << 22n;
const TARGET_PAGE_ENTRIES = 60n;

function snowflakeFromMs(ms) {
  return (BigInt(ms) - TWITTER_EPOCH_MS) << 22n;
}

function msFromSnowflake(id) {
  return Number((BigInt(id) >> 22n) + TWITTER_EPOCH_MS);
}

function encodeListCursor(aBig, bBig, type) {
  const buf = Buffer.alloc(34);
  let i = 0;
  buf[i++] = 0x0c;
  buf.writeUInt16BE(1, i); i += 2;
  buf[i++] = 0x0a;
  buf.writeUInt16BE(1, i); i += 2;
  buf.writeBigUInt64BE(BigInt(aBig), i); i += 8;
  buf[i++] = 0x0a;
  buf.writeUInt16BE(2, i); i += 2;
  buf.writeBigUInt64BE(BigInt(bBig), i); i += 8;
  buf[i++] = 0x08;
  buf.writeUInt16BE(3, i); i += 2;
  buf.writeInt32BE(Number(type), i); i += 4;
  buf[i++] = 0x00;
  buf[i++] = 0x00;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeListCursor(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const buf = Buffer.from((str + pad).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  let i = 0;
  if (buf[i++] !== 0x0c) throw new Error('bad struct');
  if (buf.readUInt16BE(i) !== 1) throw new Error('bad outer field');
  i += 2;
  if (buf[i++] !== 0x0a) throw new Error('bad A type');
  if (buf.readUInt16BE(i) !== 1) throw new Error('bad A field');
  i += 2;
  const A = buf.readBigUInt64BE(i); i += 8;
  if (buf[i++] !== 0x0a) throw new Error('bad B type');
  if (buf.readUInt16BE(i) !== 2) throw new Error('bad B field');
  i += 2;
  const B = buf.readBigUInt64BE(i); i += 8;
  if (buf[i++] !== 0x08) throw new Error('bad type type');
  if (buf.readUInt16BE(i) !== 3) throw new Error('bad type field');
  i += 2;
  const type = buf.readInt32BE(i);
  return { A, B, type };
}

function rewriteTopCursorToFillUp(decoded, pageDelta, nowMs) {
  if (!decoded || decoded.type !== 1) return null;
  const delta = pageDelta && pageDelta > 0n ? pageDelta : DEFAULT_FILL_DELTA;
  const nowSf = snowflakeFromMs(nowMs == null ? Date.now() : nowMs);
  const Btop = decoded.B;
  if (Btop >= nowSf) return null;
  let Bp = Btop + delta;
  // Within one delta of now → leave Top unchanged (would cap at now anyway).
  if (Bp >= nowSf) return null;
  return encodeListCursor(decoded.A, Bp, 2);
}

const SAMPLES = [
  {
    name: 'bottom',
    str: 'DAABCgABHT48xZl__zoKAAIdPX-MitchUQgAAwAAAAIAAA',
    A: 0x1d3e3cc5997fff3an,
    B: 0x1d3d7f8c8ad72151n,
    type: 2
  },
  {
    name: 'top',
    str: 'DAABCgABHT48xZmAJq4KAAIdPd-tVVeA3QgAAwAAAAEAAA',
    A: 0x1d3e3cc5998026aen,
    B: 0x1d3ddfad555780ddn,
    type: 1
  }
];

// From browser test of v3.24 jump on Olo list.
const JUMP_BOTTOM = 'DAABCgABHT4-p3UAAAAKAAIdOb3Co9dQwAgAAwAAAAIAAA';
const SCROLL_UP_TOP = 'DAABCgABHT4-p3UAJxEKAAIdObydq9dQwAgAAwAAAAEAAA';

let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed++;
  } else {
    console.log('ok:', msg);
  }
}

for (const s of SAMPLES) {
  const d = decodeListCursor(s.str);
  assert(d.A === s.A, `${s.name} decode A == 0x${s.A.toString(16)}`);
  assert(d.B === s.B, `${s.name} decode B == 0x${s.B.toString(16)}`);
  assert(d.type === s.type, `${s.name} decode type == ${s.type}`);
  const enc = encodeListCursor(d.A, d.B, d.type);
  assert(enc === s.str, `${s.name} round-trip reproduces exact string`);
  const enc2 = encodeListCursor(s.A, s.B, s.type);
  assert(enc2 === s.str, `${s.name} encode from known A/B/type`);
}

assert(
  SAMPLES[1].B === 2107086136233394397n,
  'legacy top-sample B equals documented tweet id 2107086136233394397'
);

const bottoms = [
  0x1d3e3cc5997fff9dn,
  0x1d3e3cc5997fff3an,
  0x1d3e3cc5997ffed5n,
  0x1d3e3cc5997ffe71n,
  0x1d3e3cc5997ffe0cn
];
assert(bottoms[0] - bottoms[1] === 99n, 'bottom A first step decreases by 99');
for (let i = 1; i < bottoms.length; i++) {
  const d = bottoms[i - 1] - bottoms[i];
  assert(d >= 99n && d <= 101n, `bottom A step ${i} decreases by ~99 (got ${d})`);
}

const now = 1728000000000;
const sf = snowflakeFromMs(now);
assert(msFromSnowflake(sf) === now, 'msFromSnowflake(snowflakeFromMs(ms)) == ms');
assert(snowflakeFromMs(msFromSnowflake(SAMPLES[1].B)) <= SAMPLES[1].B, 'snowflake truncates low 22 bits');

const lead = BigInt(60 * 60 * 1000) << 22n;
const saved = 2107086136233394397n;
const B = saved + lead;
assert(B > saved, 'B = saved + lead is newer than saved');
assert(Number(lead >> 22n) === 60 * 60 * 1000, 'lead << 22 encodes jumpLeadMs');

// --- Browser-test jump / top samples ---
const jump = decodeListCursor(JUMP_BOTTOM);
const topUp = decodeListCursor(SCROLL_UP_TOP);
assert(jump.type === 2, 'jump cursor type is Bottom (2)');
assert(topUp.type === 1, 'scroll-up cursor type is Top (1)');
assert(jump.B === 2105922944442519744n, 'jump B == 2105922944442519744');
assert(topUp.B === 2105921686151319744n, 'top B == 2105921686151319744');
assert(jump.B - topUp.B === (BigInt(5 * 60 * 1000) << 22n), 'top.B is jump.B minus 5min lead used in the v3.24 capture (≈ newest on page)');

const jumpBDate = new Date(msFromSnowflake(jump.B)).toISOString();
const topBDate = new Date(msFromSnowflake(topUp.B)).toISOString();
assert(jumpBDate.startsWith('2026-10-02T07:28'), `jump B date ${jumpBDate}`);
assert(topBDate.startsWith('2026-10-02T07:23'), `top B date ${topBDate}`);
console.log('info: jump B ≈', jumpBDate, '| top B ≈', topBDate);

// Top→Bottom fill-up rewrite with default 3h delta
const nowMs = Date.parse('2026-10-05T19:30:00.000Z');
const rewritten = rewriteTopCursorToFillUp(topUp, null, nowMs);
assert(!!rewritten, 'rewrite returns a cursor string');
const rw = decodeListCursor(rewritten);
assert(rw.type === 2, 'rewritten cursor is Bottom (2)');
assert(rw.A === topUp.A, 'rewritten keeps same A');
assert(rw.B === topUp.B + DEFAULT_FILL_DELTA, 'rewritten B = B_top + 3h delta');
assert(
  new Date(msFromSnowflake(rw.B)).toISOString().startsWith('2026-10-02T10:23'),
  'rewritten B lands ~3h newer than top B'
);

// Near live head: leave unchanged
const nearNow = snowflakeFromMs(nowMs) - (DEFAULT_FILL_DELTA / 2n);
const nearDecoded = { A: topUp.A, B: nearNow, type: 1 };
assert(
  rewriteTopCursorToFillUp(nearDecoded, null, nowMs) === null,
  'near-now Top request left unchanged'
);

// Bottom cursors are never rewritten by this helper
assert(
  rewriteTopCursorToFillUp({ A: jump.A, B: jump.B, type: 2 }, null, nowMs) === null,
  'Bottom cursor not rewritten'
);

// Adaptive density: 100 posts over ~7h → delta for ~60 entries
const sevenH = BigInt(7 * 60 * 60 * 1000) << 22n;
const densityDelta = (sevenH * TARGET_PAGE_ENTRIES) / 99n;
const densRewritten = rewriteTopCursorToFillUp(topUp, densityDelta, nowMs);
const dens = decodeListCursor(densRewritten);
assert(dens.type === 2, 'density rewrite is Bottom');
assert(dens.B === topUp.B + densityDelta, 'density rewrite uses adaptive delta');
const densHours = Number((densityDelta >> 22n) / 3600000n);
assert(densHours >= 3 && densHours <= 5, `density delta ≈ 4h of list time (got ~${densHours}h)`);

// Delta that would reach/pass now → leave Top unchanged (live newest)
const hugeDelta = BigInt(30 * 24 * 60 * 60 * 1000) << 22n;
assert(
  rewriteTopCursorToFillUp(topUp, hugeDelta, nowMs) === null,
  'delta reaching now leaves Top unchanged'
);
// Explicit cap path: B′ = min(B_top+delta, now) is not emitted; null instead.
assert(topUp.B + hugeDelta > snowflakeFromMs(nowMs), 'huge delta overshoots now');

// --- Sortmap extraction (repost-aware) ---
function unwrapTweetResult(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) return result.tweet;
  return result;
}

function extractSortMapFromListJson(json) {
  const sortIndexes = [];
  const pairs = [];
  const tl = json && json.data && json.data.list &&
    json.data.list.tweets_timeline && json.data.list.tweets_timeline.timeline;
  const instructions = tl && tl.instructions;
  if (!Array.isArray(instructions)) return { sortIndexes, pairs };

  function addFromTweetResult(result, sortIndex) {
    const tweet = unwrapTweetResult(result);
    if (!tweet) return;
    if (tweet.rest_id) pairs.push([String(tweet.rest_id), sortIndex]);
    const rt = tweet.legacy && tweet.legacy.retweeted_status_result &&
      tweet.legacy.retweeted_status_result.result;
    if (rt) {
      const inner = unwrapTweetResult(rt);
      if (inner && inner.rest_id) pairs.push([String(inner.rest_id), sortIndex]);
    }
  }

  for (const inst of instructions) {
    if (!inst || inst.type !== 'TimelineAddEntries' || !Array.isArray(inst.entries)) continue;
    for (const ent of inst.entries) {
      if (!ent) continue;
      const eid = ent.entryId;
      const sortIndex = ent.sortIndex != null ? String(ent.sortIndex) : null;
      if (typeof eid !== 'string' || !eid.startsWith('tweet-') || !sortIndex) continue;
      if (!/^\d+$/.test(sortIndex)) continue;
      sortIndexes.push(BigInt(sortIndex));
      const fromEntry = eid.slice(6);
      if (/^\d+$/.test(fromEntry)) pairs.push([fromEntry, sortIndex]);
      const result = ent.content && ent.content.itemContent &&
        ent.content.itemContent.tweet_results &&
        ent.content.itemContent.tweet_results.result;
      addFromTweetResult(result, sortIndex);
    }
  }
  return { sortIndexes, pairs };
}

function buildSortMap(pairs) {
  const map = new Map();
  for (const [id, si] of pairs) {
    const prev = map.get(id);
    if (prev == null || BigInt(si) > BigInt(prev)) map.set(id, si);
  }
  return map;
}

const REPOST_SORT = '2107190564599365632';
const ORIGINAL_ID = '2105921686151319744';
const REPOST_ID = '2107190564599365000';

const sampleResponse = {
  data: {
    list: {
      tweets_timeline: {
        timeline: {
          instructions: [{
            type: 'TimelineAddEntries',
            entries: [
              {
                entryId: `tweet-${REPOST_ID}`,
                sortIndex: REPOST_SORT,
                content: {
                  itemContent: {
                    tweet_results: {
                      result: {
                        __typename: 'Tweet',
                        rest_id: REPOST_ID,
                        legacy: {
                          retweeted_status_result: {
                            result: {
                              __typename: 'Tweet',
                              rest_id: ORIGINAL_ID
                            }
                          }
                        }
                      }
                    }
                  }
                }
              },
              {
                entryId: 'tweet-111',
                sortIndex: '2107190000000000000',
                content: {
                  itemContent: {
                    tweet_results: {
                      result: {
                        __typename: 'TweetWithVisibilityResults',
                        tweet: {
                          __typename: 'Tweet',
                          rest_id: '111',
                          legacy: {
                            retweeted_status_result: {
                              result: {
                                __typename: 'TweetWithVisibilityResults',
                                tweet: { rest_id: '222' }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              },
              { entryId: 'cursor-bottom-x', sortIndex: '0', content: { cursorType: 'Bottom' } }
            ]
          }]
        }
      }
    }
  }
};

const extracted = extractSortMapFromListJson(sampleResponse);
const sm = buildSortMap(extracted.pairs);
assert(sm.get(ORIGINAL_ID) === REPOST_SORT, 'original displayed id maps to repost sortIndex');
assert(sm.get(REPOST_ID) === REPOST_SORT, 'outer repost rest_id maps to sortIndex');
assert(sm.get('111') === '2107190000000000000', 'TweetWithVisibilityResults outer mapped');
assert(sm.get('222') === '2107190000000000000', 'nested visibility original mapped');
assert(extracted.sortIndexes.length === 2, 'cursor entries skipped in sortIndexes');

// Jump B from sortId (+ lead), not from displayed original id
const sortId = BigInt(REPOST_SORT);
const jumpB = sortId + lead;
const wrongB = BigInt(ORIGINAL_ID) + lead;
assert(jumpB > wrongB, 'sortId-based B is newer than originalId-based B');
assert(jumpB === sortId + (BigInt(60 * 60 * 1000) << 22n), 'B = sortId + jumpLeadMs snowflake');

console.log('info: sortId jump B leads original by', Number((jumpB - wrongB) >> 22n), 'ms of snowflake time');

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nAll cursor tests passed.');
