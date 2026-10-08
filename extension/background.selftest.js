// Run: /usr/local/bin/node extension/background.selftest.js
// Loads background.js with real store.js, a fake Bili that records posts, and a fake chrome; checks bs-special / bs-follow.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");

const data = { bs_followings: { at: 1, list: ["5", "6"], followTime: { 5: 1, 6: 1 }, special: { 6: 1 }, groups: { 6: [3, 4] } } };
const local = {
  async get(k) { return Object.fromEntries([].concat(k).filter((x) => x in data).map((x) => [x, structuredClone(data[x])])); },
  async set(o) { Object.assign(data, structuredClone(o)); }
};
const calls = [];
let onMessage, onInstalled;
const injected = [];
const noop = { addListener: () => {} };
const ctx = vm.createContext({
  console, structuredClone,
  chrome: { storage: { local }, runtime: {
    onMessage: { addListener: (fn) => (onMessage = fn) }, onStartup: noop, onInstalled: { addListener: (fn) => (onInstalled = fn) },
    getManifest: () => JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"))
  },
  tabs: { query: async (q) => (q.url.includes("https://t.bilibili.com/*") ? [{ id: 3 }, { id: 4 }] : []) },
  scripting: { executeScript: async (o) => { if (o.target.tabId === 4) throw new Error("no access"); injected.push(o); } },
  action: { onClicked: noop }, alarms: { onAlarm: noop } },
  importScripts: (...files) => { if (files.includes("lib/store.js")) vm.runInContext(fs.readFileSync(path.join(__dirname, "lib/store.js"), "utf8"), ctx); }
});
ctx.Bili = {
  copyUsers: async (...a) => calls.push(["copy", ...a]),
  moveUsers: async (...a) => calls.push(["move", ...a]),
  modifyRelation: async (...a) => calls.push(["modify", ...a])
};
ctx.Jobs = { resumeAll: () => {} };
vm.runInContext(fs.readFileSync(path.join(__dirname, "background.js"), "utf8"), ctx);
const send = (msg) => new Promise((r) => onMessage(msg, {}, r));

(async () => {
  assert.equal((await send({ type: "bs-special", mid: 5, on: true })).ok, true);
  assert.deepEqual(calls.pop(), ["copy", "5", -10]);
  assert.equal(data.bs_followings.special["5"], 1);

  await send({ type: "bs-special", mid: "6", on: false });
  assert.deepEqual(calls.pop(), ["move", "6", -10, [3, 4]], "back to its own groups");
  await send({ type: "bs-special", mid: "5", on: false });
  assert.deepEqual(calls.pop(), ["move", "5", -10, 0], "默认分组 when it has none");
  assert.deepEqual(data.bs_followings.special, {});
  assert.deepEqual(data.bs_followings.list, ["5", "6"], "still followed");

  const r = await send({ type: "bs-special", mid: "7", on: true });
  assert.equal(r.ok, false, "only for accounts I follow");
  assert.equal(calls.length, 0);

  await send({ type: "bs-special", mid: "6", on: true });
  await send({ type: "bs-follow", mid: "6", act: 2 });
  assert.deepEqual([data.bs_followings.list, data.bs_followings.special, data.bs_followings.groups], [["5"], {}, {}]);

  // Unfollow records itself (source app) with the tags; a page writing the record too, or a repeat, changes nothing.
  data.bs_up_tags = [{ id: "t" }];
  data.bs_up_tag_map = { 5: ["t", "old"] };
  await send({ type: "bs-follow", mid: "5", act: 2 });
  const rec = data.bs_unfollowed["5"];
  assert.deepEqual([rec.tagIds, rec.source], [["t", "old"], "app"]);
  data.bs_unfollowed["5"] = { at: 1, tagIds: ["t"] }; // as the 关注 page writes it
  await send({ type: "bs-follow", mid: "5", act: 2 });
  assert.deepEqual(data.bs_unfollowed["5"], { at: 1, tagIds: ["t"] }, "an existing record is kept as is");
  // Follow again: record gone, live tags back (the page's own restore finds no record and leaves them).
  delete data.bs_up_tag_map["5"];
  await send({ type: "bs-follow", mid: "5", act: 1 });
  assert.deepEqual([data.bs_unfollowed["5"], data.bs_up_tag_map["5"]], [undefined, ["t"]]);
  assert.equal(data.bs_followings.list[0], "5");

  // Install/update: the manifest's content scripts go into every open B站 tab; a tab that refuses does not stop the rest.
  await onInstalled({ reason: "update" });
  assert.deepEqual(injected.map((o) => [o.target.tabId, o.files]), [[3, ["content/badges.js"]]]);
  console.log("background.selftest ok");
})().catch((e) => { console.error(e); process.exit(1); });
