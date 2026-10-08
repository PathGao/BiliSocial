// Run: /usr/local/bin/node extension/pages/settings.selftest.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = {};
ctx.globalThis = ctx;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "settings.js"), "utf8"), ctx);
const { flat, clean, changed, merge, follow, sections } = ctx.BsSettings;
const plain = (v) => JSON.parse(JSON.stringify(v));

// Clamping and rounding: what the box shows after save is this.
const c = clean({ slowDays: "0", deadDays: "12.6", pushMinutes: "1", aiNewTags: "99", alpha: 0.33, baseUrl: " https://x/v1 " });
assert.deepStrictEqual([c.slowDays, c.deadDays, c.pushMinutes, c.aiNewTags, c.alpha, c.baseUrl], [1, 13, 5, 50, 0.35, "https://x/v1"]);
assert.deepStrictEqual([clean({ aiNewTags: "" }).aiNewTags, clean({ aiNewTags: "0" }).aiNewTags, clean({ slowDays: "abc" }).slowDays], [5, 0, 90]);
assert.strictEqual(flat(undefined).aiNewTags, 5);
assert.strictEqual(flat({ ai: { model: "m" } }).model, "m");

// Interleaving (MoonDigest #84): settings page opens, graph slider writes alpha, then the page saves 慢更.
let store = { ai: { baseUrl: "https://a/v1", apiKey: "k", model: "m" }, alpha: 0.5, slowDays: 90, deadDays: 365, other: 1 };
let saved = flat(store); // page opened
let form = { ...saved, slowDays: 30 }; // user edits 慢更, does not save yet
const before = saved;
store = { ...store, alpha: 0.8 }; // graph page writes alpha
form = follow(form, before, flat(store)); // onStore: alpha follows, the edit stays
saved = flat(store);
assert.strictEqual(form.alpha, 0.8);
assert.strictEqual(form.slowDays, 30);
const keys = changed(form, saved);
assert.deepStrictEqual(plain(keys), ["slowDays"]);
assert.deepStrictEqual(plain(sections(keys)), ["更新状态"]);
// Even if onStore had not arrived yet, saving merges into the latest stored object and writes only changed keys.
const stale = { ...flat({ ...store, alpha: 0.5 }), slowDays: 30, model: "m2" };
const next = merge({ ...store }, stale, changed(stale, flat({ ...store, alpha: 0.5 })));
assert.deepStrictEqual(plain(next), { ai: { baseUrl: "https://a/v1", apiKey: "k", model: "m2" }, alpha: 0.8, slowDays: 30, deadDays: 365, other: 1 });
// An edit changed back is not unsaved.
assert.deepStrictEqual(plain(changed({ ...saved, slowDays: 90 }, saved)), []);
console.log("settings selftest ok");
