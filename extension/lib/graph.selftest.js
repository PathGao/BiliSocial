// Run: /usr/local/bin/node extension/lib/graph.selftest.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const G = require("./graph.js");

// Two communities A and B of 14 crawled followings each (each follows the next 4 in its ring), 100 fillers that only
// follow a popular account, one hidden list, and an official account everyone follows.
const people = {}, circle = {}, content = {};
const add = (mid, name) => (people[mid] = { mid, name, face: "", sign: "", ov: "" });
const A = [], B = [], F = [];
for (let i = 0; i < 14; i++) { A.push(`a${i}`); B.push(`b${i}`); add(`a${i}`, `A${i}`); add(`b${i}`, `B${i}`); }
for (let i = 0; i < 100; i++) { F.push(`f${i}`); add(`f${i}`, `F${i}`); }
add("pop", "大众号"); add("off", "哔哩哔哩创作中心"); add("h", "隐藏的人"); add("ra", "A圈外的人");
const ring = (g, i) => [1, 2, 3, 4].map((d) => g[(i + d) % g.length]);
A.forEach((m, i) => (circle[m] = { code: 0, list: [...ring(A, i), "off", ...(i < 8 ? ["ra"] : []), ...(i < 6 ? ["pop"] : [])] }));
B.forEach((m, i) => (circle[m] = { code: 0, list: [...ring(B, i), "off"] }));
F.forEach((m) => (circle[m] = { code: 0, list: ["pop", "off"] }));
circle.h = { code: 22115, list: [] };
const vids = (tid, title) => Array.from({ length: 5 }, (_, k) => ({ t: `${title} 第${k}期`, tid, c: 1700000000 - k * 86400 }));
A.forEach((m) => (content[m] = { code: 0, count: 5, tlist: { 游戏: 5 }, v: vids(1, "原神攻略") }));
B.forEach((m) => (content[m] = { code: 0, count: 5, tlist: { 美食: 5 }, v: vids(2, "家常菜谱") }));
// a0 and b0 post the same thing: content says they are alike, social says they are not
content.a0 = content.b0 = { code: 0, count: 5, tlist: { 科普: 5 }, v: vids(3, "量子力学入门") };
const st = {
  bs_me: { mid: "me" },
  bs_people: people,
  bs_followings: { list: [...A, ...B, ...F, "h"] },
  bs_circle: circle,
  bs_content: content
};

const res = G.compute(st, { alpha: 0.5 });
const byMid = new Map(res.nodes.map((n, i) => [n.mid, i]));
const N = res.nodes.length;

// Stopwords: the official account is not a node; the popular account is a stopword but still a second-layer node
assert(!byMid.has("off"), "official account excluded");
assert(byMid.has("pop") && res.nodes[byMid.get("pop")].l2 === 1, "popular account is an L2 node");
assert(byMid.has("ra") && res.nodes[byMid.get("ra")].l2 === 1, "ra followed by 8 is L2");
assert.strictEqual(res.stats.stop, 2, "stopwords: official + popular (followed by >10% of 129 lists)");
assert.strictEqual(res.sim(byMid.get("f0"), byMid.get("f1")), 0, "fillers share only a stopword -> no similarity");

// Hidden list: counted, flagged, contributes nothing
const h = res.nodes[byMid.get("h")];
assert.strictEqual(res.stats.hidden, 1);
assert.strictEqual(res.stats.crawled, 128);
assert(h.hidden === 1 && h.outIn.length === 0, "hidden node flagged");

// Alpha: content-only pairs a0 with b0, social-only never does
const a0 = byMid.get("a0"), b0 = byMid.get("b0");
const near = (r, i) => r.nodes[i].near.map(([j]) => j);
assert.strictEqual(near(G.compute(st, { alpha: 0 }), a0)[0], b0, "alpha 0: b0 is a0's nearest");
const social = G.compute(st, { alpha: 1 });
assert(!near(social, a0).includes(b0), "alpha 1: b0 not near a0");
assert.strictEqual(social.sim(a0, b0), 0);
assert(social.sim(a0, byMid.get("a1")) > 0);

// kNN edges: undirected, unique, i < j, similarity symmetric
const seen = new Set();
for (const [i, j, s] of res.edges) {
  assert(i < j && j < N, "edge order");
  assert(!seen.has(`${i}-${j}`), "no duplicate edge");
  seen.add(`${i}-${j}`);
  assert(Math.abs(res.sim(i, j) - res.sim(j, i)) < 1e-9 && s > 0.03);
}

// Groups: A and B each form a cluster (>= 12), fillers are 零散
const gA = new Set(A.map((m) => res.nodes[byMid.get(m)].g)), gB = new Set(B.map((m) => res.nodes[byMid.get(m)].g));
assert(gA.size === 1 && gB.size === 1 && [...gA][0] >= 0 && [...gB][0] >= 0 && [...gA][0] !== [...gB][0], "two clusters");
assert(F.every((m) => res.nodes[byMid.get(m)].g === -1), "fillers ungrouped");
assert.strictEqual(res.groups.length, 2);

// Recommendations: only L2, unfollowed sinks, activity factor
const now = 1700000000 + 10 * 86400;
const recs = G.recommend(res, { now });
assert(recs.every((r) => res.nodes[r.i].l2), "only L2");
assert.deepStrictEqual(recs.map((r) => r.mid).sort(), ["pop", "ra"]);
assert.strictEqual(recs[0].mid, "ra", "ra (similar to A) beats pop (fillers have no similarity)");
assert.match(recs[0].reason, /你关注的人里 8 人关注 TA/);
assert.strictEqual(recs[0].act, 0.8, "no content -> unknown activity");
const sunk = G.recommend(res, { now, unfollowed: { ra: { at: 1 } } });
assert(sunk[sunk.length - 1].mid === "ra" && sunk[sunk.length - 1].unfollowed, "unfollowed sinks to the bottom");
// activity factor: give ra recent / old content
content.ra = { code: 0, count: 1, tlist: {}, v: [{ t: "x", tid: 1, c: now - 5 * 86400 }] };
const st2 = { ...st, bs_content: { ...content } };
assert.strictEqual(G.recommend(G.compute(st2, { alpha: 0.5 }), { now }).find((r) => r.mid === "ra").act, 1);
assert.strictEqual(G.recommend(G.compute(st2, { alpha: 0.5 }), { now: now + 200 * 86400 }).find((r) => r.mid === "ra").act, 0.6);
assert.strictEqual(G.recommend(G.compute(st2, { alpha: 0.5 }), { now: now + 400 * 86400 }).find((r) => r.mid === "ra").act, 0.3);
// jobReady: finished, or every target stored; a paused half-crawl is not ready
assert(G.jobReady({ finishedAt: 1 }) && G.jobReady({ running: true, done: 952, total: 952 }));
assert(!G.jobReady({ running: false, done: 116, total: 952, cursor: null }), "paused circle is not ready");
assert(!G.jobReady({ running: false, done: 1285, total: 0 }) && !G.jobReady(undefined), "feed-phase count is not ready");
// 圈子 names: exact key, then a group sharing more than half of its top members; nothing for a different group
{
  const g = { mids: ["a", "b", "c", "d", "e", "f"] };
  g.key = G.groupKey(g.mids);
  assert.strictEqual(g.key, G.groupKey(["e", "d", "c", "b", "a", "z"]), "key = sorted top 5");
  const store = { [g.key]: { name: "原神圈", mids: g.mids } };
  assert.strictEqual(G.groupName(g, store).name, "原神圈");
  const moved = { key: "x", mids: ["b", "c", "d", "e", "f", "y"] }; // 5 of 6 shared
  assert.strictEqual(G.groupName(moved, store).name, "原神圈", "similar membership keeps the name");
  assert.strictEqual(G.groupName({ key: "q", mids: ["a", "b", "q", "r", "s", "t"] }, store), null, "2 of 6 is another group");
  assert(res.groups.every((gr) => gr.mids.length && gr.key === G.groupKey(gr.mids)), "compute gives groups mids and key");
}
console.log("synthetic: ok");

// Synthetic fixtures (dev/make-fixtures.mjs): six clean themes, so neighbours should mostly share the 「知名X UP主」 label.
const fx = path.join(__dirname, "../../dev-fixtures/storage.json");
if (!fs.existsSync(fx)) {
  console.log("fixtures: skipped (run dev/make-fixtures.mjs)");
} else {
  const fake = JSON.parse(fs.readFileSync(fx, "utf8"));
  const t = Date.now();
  const r = G.compute(fake, { alpha: 0.5 });
  const ms = Date.now() - t;
  const agree = G.labelAgreement(fake, 0.5);
  console.log(`fixtures: ${r.nodes.length} nodes, ${r.edges.length} edges, ${r.groups.length} groups, compute ${ms} ms, agreement ${agree.pct.toFixed(1)}% of ${agree.tot}`);
  assert(agree.tot > 0 && agree.pct >= 80, "fixture themes come out as clusters");
}
console.log("graph selftest passed");
