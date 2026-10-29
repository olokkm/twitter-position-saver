// Fake X ListLatestTweetsTimeline backend for tests / the iPhone simulation.
// No network, no X login: builds GraphQL-shaped list pages from a synthetic
// timeline. Cursor semantics modelled on what X does for list timelines:
//   no cursor          → newest `count` posts
//   Bottom (type 2) B  → newest `count` posts with id < B
//   Top    (type 1) B  → newest `count` posts with id > B  (from the head, so
//                        a stale Top cursor leaves a GAP — the hook must not)
export const TWITTER_EPOCH_MS = 1288834974657n;

export function snowflakeFromMs(ms) {
  return (BigInt(Math.floor(ms)) - TWITTER_EPOCH_MS) << 22n;
}
export function msFromSnowflake(id) {
  return Number((BigInt(id) >> 22n) + TWITTER_EPOCH_MS);
}

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function encodeCursor(A, B, type) {
  const buf = Buffer.alloc(34);
  let i = 0;
  buf[i++] = 0x0c; buf.writeUInt16BE(1, i); i += 2;
  buf[i++] = 0x0a; buf.writeUInt16BE(1, i); i += 2; buf.writeBigUInt64BE(BigInt(A), i); i += 8;
  buf[i++] = 0x0a; buf.writeUInt16BE(2, i); i += 2; buf.writeBigUInt64BE(BigInt(B), i); i += 8;
  buf[i++] = 0x08; buf.writeUInt16BE(3, i); i += 2; buf.writeInt32BE(Number(type), i); i += 4;
  return b64url(buf);
}
export function decodeCursor(str) {
  const buf = Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return { A: buf.readBigUInt64BE(6), B: buf.readBigUInt64BE(17), type: buf.readInt32BE(28) };
}

// Deterministic PRNG.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ~`posts` posts over `days` days ending at nowMs, bursty: 1/3 of the posts
// in short bursts, quiet nights (Warsaw 01:00–07:00 has 10% density).
export function makeDataset({ nowMs = Date.now(), days = 4, posts = 1500, seed = 42 } = {}) {
  const rnd = mulberry32(seed);
  const span = days * 86400000;
  const start = nowMs - span;
  const times = [];
  const bursts = 12;
  const burstPosts = Math.floor(posts / 3);
  for (let b = 0; b < bursts; b++) {
    const c = start + rnd() * (span - 3600000);
    const n = Math.floor(burstPosts / bursts);
    for (let i = 0; i < n; i++) times.push(c + rnd() * 25 * 60000);
  }
  while (times.length < posts) {
    const t = start + rnd() * span;
    const h = new Date(t + 3600000).getUTCHours(); // ~Warsaw hour
    if (h >= 1 && h < 7 && rnd() > 0.1) continue;
    times.push(t);
  }
  // newest post a little before "now"
  times.push(nowMs - 30000);
  const ids = new Set();
  const list = [];
  for (const t of times) {
    let id = snowflakeFromMs(Math.min(t, nowMs - 1000)) | BigInt(Math.floor(rnd() * 4194303));
    while (ids.has(id)) id += 1n;
    ids.add(id);
    list.push(id);
  }
  list.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return list.map((id, idx) => ({ id: id.toString(), ms: msFromSnowflake(id), idx }));
}

function tweetEntry(p) {
  return {
    entryId: 'tweet-' + p.id,
    sortIndex: p.id,
    content: {
      entryType: 'TimelineTimelineItem',
      __typename: 'TimelineTimelineItem',
      itemContent: {
        itemType: 'TimelineTweet',
        __typename: 'TimelineTweet',
        tweet_results: {
          result: {
            __typename: 'Tweet',
            rest_id: p.id,
            legacy: {
              id_str: p.id,
              created_at: new Date(p.ms).toUTCString(),
              full_text: 'post #' + p.idx + ' @ ' + new Date(p.ms).toISOString()
            }
          }
        }
      }
    }
  };
}
function cursorEntry(kind, A, B, type, sortIndex) {
  return {
    entryId: 'cursor-' + kind + '-' + sortIndex,
    sortIndex: String(sortIndex),
    content: {
      entryType: 'TimelineTimelineCursor',
      __typename: 'TimelineTimelineCursor',
      value: encodeCursor(A, B, type),
      cursorType: kind === 'top' ? 'Top' : 'Bottom'
    }
  };
}

export function createFakeList(dataset, { A = null } = {}) {
  const posts = dataset; // newest first
  const log = [];
  function select(vars) {
    const count = Number(vars.count) > 0 ? Number(vars.count) : 20;
    let cur = null;
    if (vars.cursor) cur = decodeCursor(String(vars.cursor));
    let sel;
    let kind = 'head';
    if (!cur) sel = posts.slice(0, count);
    else if (cur.type === 2) { kind = 'bottom'; sel = posts.filter((p) => BigInt(p.id) < cur.B).slice(0, count); }
    else { kind = 'top'; sel = posts.filter((p) => BigInt(p.id) > cur.B).slice(0, count); }
    return { sel, cur, count, kind };
  }
  function respond(urlStr) {
    const u = new URL(urlStr, 'https://x.com/');
    const vars = JSON.parse(u.searchParams.get('variables') || '{}');
    const { sel, cur, count, kind } = select(vars);
    const a = cur ? cur.A : (A != null ? BigInt(A) : snowflakeFromMs(Date.now()));
    const entries = sel.map(tweetEntry);
    if (sel.length) {
      const newest = BigInt(sel[0].id);
      const oldest = BigInt(sel[sel.length - 1].id);
      entries.push(cursorEntry('top', a, newest, 1, newest + 1n));
      entries.push(cursorEntry('bottom', a, oldest, 2, oldest - 1n));
    } else if (cur) {
      // nothing in that direction: echo the cursor (X keeps it)
      entries.push(cursorEntry(cur.type === 1 ? 'top' : 'bottom', a, cur.B, cur.type, cur.B));
    }
    log.push({ kind, count, B: cur ? cur.B.toString() : null, n: sel.length, at: Date.now() });
    return {
      data: { list: { tweets_timeline: { timeline: {
        instructions: [{ type: 'TimelineAddEntries', entries }],
        metadata: { scribeConfig: { page: 'list' } }
      } } } }
    };
  }
  return { respond, log, posts };
}

export function listUrl(cursor, count) {
  const vars = { listId: '1234567890', count: count || 20, includePromotedContent: false };
  if (cursor) vars.cursor = cursor;
  return 'https://x.com/i/api/graphql/FAKEqid/ListLatestTweetsTimeline?variables=' +
    encodeURIComponent(JSON.stringify(vars)) + '&features=%7B%7D';
}
