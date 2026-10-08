// #feed (动态) data: pages of the 关注 video feed for the app page, through the shared Bili queue. Defines globalThis.Feed.
// Pages are cached for CACHE_MS in memory and in chrome.storage.session (the worker may sleep between scrolls), keyed by
// offset; "" is page 1. Nothing goes to chrome.storage.local.
(() => {
  const CACHE_MS = 5 * 60 * 1000;
  const SESSION_KEY = "bs_feed_cache";
  const mem = new Map(); // offset -> { at, page }
  const inflight = new Map(); // offset -> Promise<page>

  // Pure: one feed/all item -> a card, or null for anything that is not a video.
  function card(it) {
    const a = it?.modules?.module_dynamic?.major?.archive;
    if (!a?.bvid) return null;
    const au = it.modules.module_author || {};
    return {
      bvid: a.bvid,
      title: a.title || "",
      cover: a.cover || "",
      duration: a.duration_text || "",
      play: Bili.parseCount(a.stat?.play),
      mid: String(au.mid ?? ""),
      name: au.name || "",
      face: au.face || "",
      at: Number(au.pub_ts) || 0
    };
  }

  // Pure: raw feed/all data -> { items, offset, hasMore }.
  function shape(d) {
    return { items: (d?.items || []).map(card).filter(Boolean), offset: d?.offset || "", hasMore: !!d?.has_more };
  }

  const session = () => globalThis.chrome?.storage?.session;

  async function cached(offset, now) {
    let hit = mem.get(offset);
    if (!hit && session()) {
      hit = ((await session().get(SESSION_KEY))[SESSION_KEY] || {})[offset];
      if (hit) mem.set(offset, hit);
    }
    return hit && now - hit.at < CACHE_MS ? hit.page : null;
  }

  async function save(offset, page, now) {
    mem.set(offset, { at: now, page });
    if (!session()) return;
    const all = (await session().get(SESSION_KEY))[SESSION_KEY] || {};
    for (const [k, v] of Object.entries(all)) if (now - v.at >= CACHE_MS) delete all[k];
    all[offset] = { at: now, page };
    await session().set({ [SESSION_KEY]: all });
  }

  // bs-feed { offset } -> { items, offset, hasMore }. Same-offset calls share one request.
  async function page({ offset = "" } = {}) {
    offset = String(offset || "");
    const now = Bili.io.now();
    const hit = await cached(offset, now);
    if (hit) return hit;
    if (!inflight.has(offset)) {
      const run = Bili.getData(`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?type=video${offset ? `&offset=${encodeURIComponent(offset)}` : ""}`)
        .then(async (d) => {
          const p = shape(d);
          await save(offset, p, now);
          return p;
        })
        .finally(() => inflight.delete(offset));
      inflight.set(offset, run);
    }
    return inflight.get(offset);
  }

  // bs-open-app { hash }: the badge chips on B站 pages open app.html#<hash> in a new tab.
  async function open({ hash = "" } = {}) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`app.html#${String(hash).replace(/^#/, "")}`) });
  }

  globalThis.Feed = { card, shape, page, open, CACHE_MS };
})();
