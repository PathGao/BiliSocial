// Run: /usr/local/bin/node extension/lib/push.selftest.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const db = {
  bs_settings: { push: true, pushMinutes: 15 },
  bs_up_tags: [{ id: "a", name: "常看", push: true }, { id: "b", name: "游戏", push: false }],
  bs_up_tag_map: { 1: ["a"], 2: ["b"], 3: ["b", "a"] }
};
const notified = [];
let feed = { items: [], baseline: "100" };
let updateNum = 0;
let feedCalls = 0;
const ctx = {
  console,
  Store: { get: async (k, f) => (k in db ? JSON.parse(JSON.stringify(db[k])) : f), set: async (k, v) => { db[k] = v; } },
  Bili: { feedUpdate: async () => ({ updateNum }), feedVideo: async () => (feedCalls++, feed) },
  chrome: { notifications: { create: (id, o) => notified.push([id, o.title, o.contextMessage]) } } // no alarms: setup skipped
};
ctx.globalThis = ctx;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "push.js"), "utf8"), ctx);
const { Push } = ctx;
const v = (bvid, mid) => ({ bvid, mid, name: `UP${mid}`, title: `T${bvid}` });

// pure pick
assert.deepStrictEqual(Push.pick([v("x", "1"), v("y", "2"), v("z", "3"), v("w", "4"), { mid: "1" }], db.bs_up_tags, db.bs_up_tag_map, ["z"]).map((i) => i.bvid), ["x"]);
assert.deepStrictEqual(Push.pick([v("x", "1")], [{ id: "a", push: false }], db.bs_up_tag_map, []), []);
assert.strictEqual(Push.nextSeen(Array.from({ length: 400 }, (_, i) => v(`b${i}`, "1")), ["old"]).length, 300);

(async () => {
  // 1. first check: baseline only, nothing notified
  feed = { items: [v("old1", "1"), v("old2", "3")], baseline: "100" };
  await Push.check();
  assert.deepStrictEqual(notified, []);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(db.bs_push)), { baseline: "100", seen: ["old1", "old2"] });

  // 2. nothing new: feed not read
  await Push.check();
  assert.strictEqual(feedCalls, 1);

  // 3. new videos: only push-tagged UPs, not the seen ones
  updateNum = 3;
  feed = { items: [v("n1", "1"), v("n2", "2"), v("n3", "3"), v("old1", "1")], baseline: "200" };
  await Push.check();
  assert.deepStrictEqual(notified.map((n) => n[0]), ["n1", "n3"]);
  assert.deepStrictEqual(notified[0], ["n1", "UP1 发了新视频", "常看"]);
  assert.deepStrictEqual(notified[1][2], "游戏、常看");
  assert.strictEqual(db.bs_push.baseline, "200");

  // 4. same page again: no repeats
  await Push.check();
  assert.strictEqual(notified.length, 2);

  // 5. master switch off: nothing read
  db.bs_settings.push = false;
  await Push.check();
  assert.strictEqual(feedCalls, 3);
  console.log("push selftest ok");
})().catch((e) => { console.error(e); process.exit(1); });
