// Run: /usr/local/bin/node extension/pages/feed.selftest.js — the #feed list merge (dedupe + newest first).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let def = null;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "feed.js"), "utf8"), { BS: { page: (_, d) => (def = d) } });
const { merge } = def;
const v = (bvid, at) => ({ bvid, at });
const ids = (r) => r.items.map((it) => it.bvid).join(" ");

// a later page with a newer video (pinned or late) moves it to the top; duplicates are dropped
let r = merge([v("a", 50), v("b", 40)], [v("b", 40), v("c", 60), v("d", 10), v("d", 10)]);
assert.strictEqual(ids(r), "c a b d");
assert.deepStrictEqual(r.add.map((it) => it.bvid), ["c", "d"]);
// equal times keep arrival order; the input is not changed
const before = [v("x", 5), v("y", 5)];
r = merge(before, [v("z", 5)]);
assert.strictEqual(ids(r), "x y z");
assert.strictEqual(before.length, 2);
// nothing new
assert.strictEqual(merge([v("a", 1)], [v("a", 1)]).add.length, 0);
console.log("feed page selftest ok");
