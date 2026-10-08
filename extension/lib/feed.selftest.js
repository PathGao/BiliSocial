// Run: /usr/local/bin/node extension/lib/feed.selftest.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let now = 1000000;
const calls = [];
const sessionDb = {};
const raw = (bvid, mid) => ({
  modules: {
    module_author: { mid: Number(mid), name: `UP${mid}`, face: "f", pub_ts: 1700000000 },
    module_dynamic: { major: { archive: { bvid, title: `T${bvid}`, cover: "c", duration_text: "12:34", stat: { play: "1.2万" } } } }
  }
});
const ctx = {
  console,
  Bili: {
    io: { now: () => now },
    parseCount: (v) => (String(v).includes("万") ? parseFloat(v) * 1e4 : Number(v) || 0),
    getData: async (url) => {
      calls.push(url);
      return { items: [raw("BV1", 7), { modules: { module_dynamic: { major: { type: "MAJOR_TYPE_DRAW" } } } }, raw("BV2", 8)], offset: "next", has_more: true };
    }
  },
  chrome: {
    storage: { session: { get: async (k) => ({ [k]: sessionDb[k] && JSON.parse(JSON.stringify(sessionDb[k])) }), set: async (o) => Object.assign(sessionDb, o) } }
  }
};
ctx.globalThis = ctx;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "feed.js"), "utf8"), ctx);
const { Feed } = ctx;

(async () => {
  // shape keeps only videos, with string mids and parsed play counts
  const p = Feed.shape({ items: [raw("BVx", 5), {}], offset: "o", has_more: 0 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p)), {
    items: [{ bvid: "BVx", title: "TBVx", cover: "c", duration: "12:34", play: 12000, mid: "5", name: "UP5", face: "f", at: 1700000000 }],
    offset: "o",
    hasMore: false
  });

  // concurrent same-offset calls share one request; the cache answers until CACHE_MS passes
  const [a, b] = await Promise.all([Feed.page({}), Feed.page({ offset: "" })]);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(a, b);
  assert.deepStrictEqual(a.items.map((i) => i.bvid), ["BV1", "BV2"]);
  assert.strictEqual(a.offset, "next");
  await Feed.page({ offset: "abc" });
  assert.ok(calls[1].endsWith("&offset=abc"));
  assert.ok(!calls[0].includes("offset="));
  now += Feed.CACHE_MS - 1;
  await Feed.page({});
  assert.strictEqual(calls.length, 2);
  now += 2;
  await Feed.page({});
  assert.strictEqual(calls.length, 3);
  // session copy survives, expired entries are pruned on write
  assert.deepStrictEqual(Object.keys(sessionDb.bs_feed_cache), [""]);
  console.log("feed selftest ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
