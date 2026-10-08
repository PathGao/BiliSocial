// Run: /usr/local/bin/node extension/lib/jobs.selftest.js
// Each "worker" is a fresh vm context running store.js + jobs.js over one shared fake chrome.storage.local,
// so killing a worker (a request that never answers) and starting another one tests resume.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");

const SRC = ["store.js", "jobs.js"].map((f) => fs.readFileSync(path.join(__dirname, f), "utf8"));

function makeStorage(data = {}) {
  const clone = (v) => (v === undefined ? v : structuredClone(v));
  return {
    data,
    async get(key) {
      const keys = key == null ? Object.keys(data) : [].concat(key);
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, clone(data[k])]));
    },
    async set(obj) { Object.assign(data, clone(obj)); },
    async remove(key) { for (const k of [].concat(key)) delete data[k]; }
  };
}

function worker(storage, api) {
  const alarms = [];
  const ctx = vm.createContext({
    console, structuredClone, Proxy,
    setInterval: () => 1, clearInterval: () => {},
    chrome: { storage: { local: storage }, runtime: {}, alarms: { create: (n) => alarms.push("create:" + n), clear: (n) => alarms.push("clear:" + n) } },
    Bili: api
  });
  for (const s of SRC) vm.runInContext(s, ctx);
  return { Jobs: ctx.Jobs, alarms };
}

const never = () => new Promise(() => {});
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn) {
  for (let i = 0; i < 1000; i++) { if (await fn()) return; await tick(); }
  throw new Error("timed out waiting");
}

(async () => {
  // ---- mine: me, all followings (newest first), all fans with follow time and 互关 ----
  {
    const st = makeStorage();
    const fol = Array.from({ length: 120 }, (_, i) => ({ mid: String(100 + i), name: "u" + i, face: "f", sign: "s", ov: "", mtime: 2000 - i, special: i === 3, groups: i === 3 ? [7] : [] }));
    const api = {
      nav: async () => ({ isLogin: true, mid: "1", name: "我", face: "me.jpg" }),
      relationStat: async () => ({ following: 120, follower: 3 }),
      userCards: async () => [{ mid: "1", sign: "签名" }],
      followings: async (mid, pn) => ({ code: 0, total: 120, list: fol.slice((pn - 1) * 50, pn * 50) }),
      followers: async (mid, pn) => ({ total: 3, list: pn > 1 ? [] : [
        { mid: "100", name: "u0", mtime: 50, mutual: true },
        { mid: "900", name: "fan", mtime: 40, mutual: false },
        { mid: "901", name: "fan2", mtime: 30, mutual: false }
      ] })
    };
    const { Jobs, alarms } = worker(st, api);
    await Jobs.start("mine");
    await Jobs.wait("mine");
    const d = st.data;
    assert.equal(d.bs_me.sign, "签名");
    assert.equal(d.bs_me.following, 120);
    assert.equal(d.bs_followings.list.length, 120);
    assert.equal(d.bs_followings.list[0], "100");
    assert.equal(d.bs_followings.followTime["100"], 2000);
    assert.deepEqual([d.bs_followings.special, d.bs_followings.groups], [{ 103: 1 }, { 103: [7] }]);
    assert.deepEqual(d.bs_fans.list[0], { mid: "100", followTime: 50, mutual: true });
    assert.equal(d.bs_people["900"].name, "fan");
    assert.equal(d.bs_jobs.mine.running, false);
    assert.ok(d.bs_jobs.mine.finishedAt);
    assert.deepEqual(alarms.slice(0, 2), ["create:bs-keepalive", "clear:bs-keepalive"]);
    await until(() => d.bs_jobs.content);
    await Jobs.wait("content");
    assert.ok(d.bs_jobs.content, "a finished mine starts 投稿内容 when there is none yet");
  }

  // ---- circle: hidden lists recorded, ≤2 pages, resume after the worker is killed ----
  {
    const targets = Array.from({ length: 25 }, (_, i) => String(1000 + i));
    const st = makeStorage({ bs_followings: { at: 1, list: targets }, bs_me: { mid: "1" } });
    let calls = 0;
    const answer = (mid, pn) => {
      if (Number(mid) % 4 === 0) return { code: 22115, message: "用户已设置隐私", total: 0, list: [] };
      if (mid === "1001") return { code: 0, total: 400, list: Array.from({ length: 50 }, (_, i) => ({ mid: `${pn}-${i}`, name: "x" })) };
      return { code: 0, total: 2, list: [{ mid: "7", name: "seven" }, { mid: mid + "x", name: "y" }] };
    };
    // First worker dies (its request never answers) while fetching the 17th account.
    const first = worker(st, { followings: async (mid, pn) => (++calls > 17 ? never() : answer(mid, pn)) });
    await first.Jobs.start("circle");
    await until(() => calls > 17);
    assert.equal(Object.keys(st.data.bs_circle).length, 15, "flushed every 5 accounts");
    assert.equal(st.data.bs_jobs.circle.running, true);
    // A new worker resumes what is still marked running and skips the 10 done.
    const seen = [];
    const second = worker(st, { followings: async (mid, pn) => { seen.push(mid); return answer(mid, pn); }, sameFollowings: async () => ({ code: 0, total: 2, list: [{ mid: "1002" }, { mid: "1-0" }] }) });
    await second.Jobs.resumeAll();
    await second.Jobs.wait("circle");
    const c = st.data.bs_circle;
    assert.equal(Object.keys(c).length, 25);
    assert.equal(seen.includes("1000"), false);
    assert.deepEqual({ code: c["1004"].code, list: c["1004"].list }, { code: 22115, list: [] });
    assert.equal(c["1001"].plain, 100, "others: at most 2 pages");
    assert.deepEqual(c["1001"].list.slice(99), ["2-49", "1002"], "common follows appended without duplicates");
    assert.equal(c["1001"].total, 400);
    assert.equal(st.data.bs_people["7"].name, "seven");
    assert.equal(st.data.bs_jobs.circle.done, 1, "phase 2 counts the one cut list");
    assert.ok(st.data.bs_jobs.circle.finishedAt);
  }

  // ---- circle: common follows fill cut lists; 更新 checks page 1 only; hidden lists wait 30 days; back-fill; resume ----
  {
    // Fake B站: lists[mid] newest first, or null = hidden. Others' lists stop at 100; same/followings is not capped.
    const mine = ["A", "B", "C", "D"];
    const xs = (n, p) => Array.from({ length: n }, (_, i) => p + i);
    const W = { A: [...xs(5, "x"), "D", ...xs(134, "x5"), "B", "C"], B: ["y0", "y1", "A"], C: null, D: ["z0", "z1"] };
    const asked = [];
    const api = {
      followings: async (mid, pn) => {
        asked.push(`f:${mid}:${pn}`);
        if (!W[mid]) return { code: 22115, total: 0, list: [] };
        return { code: 0, total: W[mid].length, list: W[mid].slice(0, 100).slice((pn - 1) * 50, pn * 50).map((m) => ({ mid: m, name: m })) };
      },
      sameFollowings: async (mid, pn) => {
        asked.push(`s:${mid}:${pn}`);
        if (!W[mid]) return { code: 22115, total: 0, list: [] };
        const l = W[mid].filter((m) => mine.includes(m));
        return { code: 0, total: l.length, list: l.slice((pn - 1) * 50, pn * 50).map((m) => ({ mid: m })) };
      }
    };
    // bs_content complete, so a finished run does not start 投稿内容 (which would queue the next run).
    const content = Object.fromEntries(mine.map((m) => [m, { code: 0 }]));
    const st = makeStorage({ bs_followings: { at: 1, list: mine }, bs_me: { mid: "1" }, bs_content: content });
    // Pretend the stored checks happened `sec` ago.
    const age = (sec) => { for (const d of Object.values(st.data.bs_circle)) for (const k of ["at", "checkedAt", "sameAt"]) if (d[k]) d[k] -= sec; };
    const { Jobs } = worker(st, api);
    const run = async () => { asked.length = 0; await Jobs.start("circle"); await Jobs.wait("circle"); return asked.slice().sort(); };

    // First run: whole lists, then common follows for the cut one (A: 142 follows, only 100 given).
    assert.deepEqual(await run(), ["f:A:1", "f:A:2", "f:B:1", "f:C:1", "f:D:1", "s:A:1"]);
    let c = st.data.bs_circle;
    assert.deepEqual([c.A.plain, c.A.same, c.A.list.length, c.A.list.slice(100)], [100, 3, 102, ["B", "C"]]);
    assert.ok(c.A.sameAt);
    assert.equal(c.B.sameAt, undefined, "a whole list needs no common follows");
    assert.equal(c.C.code, 22115);

    // 更新 with one new follow on B's page 1: 1 request per public list, common follows of A again, C skipped.
    age(3600);
    W.B.unshift("y2");
    assert.deepEqual(await run(), ["f:A:1", "f:B:1", "f:D:1", "s:A:1"]);
    c = st.data.bs_circle;
    assert.deepEqual([c.B.list, c.B.total], [["y2", "y0", "y1", "A"], 4]);
    assert.equal(st.data.bs_people.y2.name, "y2");
    assert.deepEqual(c.A.list.slice(100), ["B", "C"]);

    // A removal (total shrank): that list is fetched again in full.
    age(3600);
    W.A.splice(2, 1);
    assert.deepEqual(await run(), ["f:A:1", "f:A:2", "f:B:1", "f:D:1", "s:A:1"]);
    c = st.data.bs_circle;
    assert.deepEqual([c.A.total, c.A.plain, c.A.list.includes("x2"), c.A.list[99], c.A.list.slice(100)], [141, 100, false, "x594", ["B", "C"]]);

    // A hidden list is asked again once its last check is 30 days old (not after 8 days).
    age(8 * 86400);
    assert.ok(!(await run()).includes("f:C:1"), "hidden list not asked again after 8 days");
    age(23 * 86400);
    assert.deepEqual(await run(), ["f:A:1", "f:B:1", "f:C:1", "f:D:1", "s:A:1"]);
    assert.ok(st.data.bs_jobs.circle.lastFinishedAt);

    // Back-fill: records from before common follows (no sameAt) get them on the next run, lists untouched.
    const st2 = makeStorage({
      bs_followings: { at: 1, list: mine }, bs_me: { mid: "1" }, bs_content: content,
      bs_circle: { A: { code: 0, total: 141, list: W.A.slice(0, 100), at: 5 }, B: { code: 0, total: 4, list: W.B, at: 5 }, C: { code: 22115, total: 0, list: [], at: 5 }, D: { code: 0, total: 2, list: W.D, at: 5 } }
    });
    asked.length = 0;
    const w2 = worker(st2, api);
    await w2.Jobs.start("circle");
    await w2.Jobs.wait("circle");
    assert.deepEqual(asked, ["s:A:1"]);
    assert.deepEqual([st2.data.bs_circle.A.plain, st2.data.bs_circle.A.list.slice(100)], [100, ["B", "C"]]);
  }

  // ---- circle resume: a killed 更新 keeps its mode and skips what it checked; a killed phase 2 skips filled lists ----
  {
    const mine = Array.from({ length: 8 }, (_, i) => "m" + i);
    const big = (mid) => [...Array.from({ length: 120 }, (_, i) => `${mid}-${i}`), ...mine.filter((m) => m !== mid)];
    const asked = [];
    let die = Infinity;
    const api = {
      followings: async (mid, pn) => { asked.push(`f:${mid}:${pn}`); if (asked.length >= die) return never(); return { code: 0, total: 127, list: big(mid).slice(0, 100).slice((pn - 1) * 50, pn * 50).map((m) => ({ mid: m, name: m })) }; },
      sameFollowings: async (mid) => { asked.push(`s:${mid}`); if (asked.length >= die) return never(); return { code: 0, total: 7, list: mine.filter((m) => m !== mid).map((m) => ({ mid: m })) }; }
    };
    const st = makeStorage({ bs_followings: { at: 1, list: mine }, bs_me: { mid: "1" }, bs_content: Object.fromEntries(mine.map((m) => [m, { code: 0 }])) });
    // First run dies in phase 2 at the 7th list: 16 list requests, then 6 common-follow requests answered.
    die = 16 + 7;
    const w1 = worker(st, api);
    await w1.Jobs.start("circle");
    await until(() => asked.length >= die);
    assert.equal(st.data.bs_jobs.circle.cursor.phase, "same");
    assert.equal(Object.values(st.data.bs_circle).filter((d) => d.sameAt).length, 5, "flushed every 5");
    asked.length = 0;
    die = Infinity;
    const w2 = worker(st, api);
    await w2.Jobs.resumeAll();
    await w2.Jobs.wait("circle");
    assert.deepEqual(asked, ["s:m5", "s:m6", "s:m7"]);
    assert.ok(Object.values(st.data.bs_circle).every((d) => d.same === 7 && d.list.length === 107));

    // 更新 killed after 6 page-1 checks; the resumed run is still 更新 and asks only the other 2.
    for (const d of Object.values(st.data.bs_circle)) for (const k of ["at", "checkedAt", "sameAt"]) d[k] -= 3600;
    asked.length = 0;
    die = 7;
    await w2.Jobs.start("circle");
    await until(() => asked.length >= die);
    assert.match(st.data.bs_jobs.circle.step, /更新关注的关注 · 第 1\/2 步 · 只查第一页/);
    asked.length = 0;
    die = Infinity;
    const w3 = worker(st, api);
    await w3.Jobs.resumeAll();
    await w3.Jobs.wait("circle");
    assert.deepEqual(asked.filter((a) => a.startsWith("f:")), ["f:m5:1", "f:m6:1", "f:m7:1"], "page 1 only, the 5 flushed ones skipped");
    assert.equal(asked.filter((a) => a.startsWith("s:")).length, 8);
  }

  // ---- content: stop after the current request, then resume; THROTTLED pauses with a flag ----
  {
    const l1 = ["a", "b", "c"];
    const circle = Object.fromEntries(Array.from({ length: 6 }, (_, i) => ["f" + i, { code: 0, list: i < 5 ? ["L2", "a"] : ["L2"] }]));
    const st = makeStorage({ bs_followings: { at: 1, list: l1 }, bs_circle: circle, bs_me: { mid: "1" } });
    // L2 is followed by 6 (≥5) and not one of mine.
    const { Jobs } = worker(st, {});
    assert.deepEqual([...Jobs.contentTargets(l1, circle, "1")], ["a", "b", "c", "L2"]);

    let release;
    const gate = new Promise((r) => (release = r));
    const asked = [];
    const noFeed = async () => ({ items: [], offset: "", hasMore: false });
    const api = { feedVideo: noFeed, arcSearch: async (mid) => { asked.push(mid); if (mid === "b") await gate; if (mid === "c") throw Object.assign(new Error("x"), { code: -404 }); return { code: 0, count: 1, tlist: {}, v: [] }; } };
    const w1 = worker(st, api);
    await w1.Jobs.start("content");
    await until(() => asked.includes("b"));
    await w1.Jobs.stop("content");
    release();
    await w1.Jobs.wait("content");
    assert.deepEqual(asked, ["a", "b"], "stop lands without waiting for the request in flight");
    assert.equal(st.data.bs_jobs.content.running, false);
    assert.equal(st.data.bs_jobs.content.finishedAt, null);
    assert.deepEqual(Object.keys(st.data.bs_content).sort(), ["a"], "the dropped answer is not stored");

    let throttle = true;
    const w2 = worker(st, { feedVideo: noFeed, arcSearch: async (mid) => { asked.push(mid); if (throttle && mid === "L2") throw Object.assign(new Error("被 B站 限流，已暂停"), { code: "THROTTLED" }); return api.arcSearch(mid); } });
    await w2.Jobs.start("content");
    await w2.Jobs.wait("content");
    assert.equal(st.data.bs_content.c.code, -404, "B站 error codes are recorded, not fatal");
    assert.equal(st.data.bs_jobs.content.throttled, true);
    assert.equal(st.data.bs_jobs.content.error, "被 B站 限流，已暂停");
    throttle = false;
    await w2.Jobs.start("content");
    await w2.Jobs.wait("content");
    assert.equal(st.data.bs_jobs.content.throttled, false);
    assert.ok(st.data.bs_content.L2);
    assert.equal(asked.filter((m) => m === "a").length, 1, "done accounts are never fetched again");
  }

  // ---- content: the video feed dates recent posters first; accounts missing from it are asked first ----
  {
    const t = Math.floor(Date.now() / 1000);
    const l1 = ["a", "b", "c"];
    const st = makeStorage({ bs_followings: { at: 1, list: l1 }, bs_circle: {}, bs_me: { mid: "1" } });
    const pages = [
      { items: [{ mid: "a", at: t - 86400 }, { mid: "b", at: t - 5 * 86400 }], offset: "p2", hasMore: true },
      { items: [{ mid: "a", at: t - 40 * 86400 }, { mid: "x", at: t - 100 * 86400 }], offset: "p3", hasMore: true }
    ];
    let pi = 0;
    const asked = [];
    const { Jobs } = worker(st, {
      feedVideo: async () => pages[pi++] || { items: [], offset: "", hasMore: false },
      arcSearch: async (mid) => { asked.push(mid); return { code: 0, count: 1, tlist: {}, v: [] }; }
    });
    await Jobs.start("content");
    await Jobs.wait("content");
    assert.equal(pi, 2, "feed paging stops once it reaches past slowDays");
    assert.equal(st.data.bs_last_post.map.a, t - 86400, "newest post per account");
    assert.ok(st.data.bs_last_post.since <= t - 90 * 86400);
    assert.deepEqual(asked, ["c", "a", "b"], "accounts missing from the feed go first");
  }

  // ---- interactions: comments + sub-comments, reposts and comments under reposts, notifications, PM counts ----
  {
    const st = makeStorage({ bs_me: { mid: "1" }, bs_people: { "10": { mid: "10", name: "老朋友", sign: "keep me", ov: "" } } });
    const api = {
      spaceDynamics: async (mid, offset) => offset
        ? { items: [{ dynId: "d2", bvid: "BV2", aid: "2", title: "二", play: 50, at: 200, commentType: 1, commentOid: "2", forwards: 0 }], hasMore: false }
        : { items: [{ dynId: "d1", bvid: "BV1", aid: "1", title: "一", play: 125000, at: 100, commentType: 1, commentOid: "1", forwards: 2 }, { dynId: "t", bvid: "" }], hasMore: true, offset: "o1" },
      replies: async (type, oid, pn) => {
        if (pn > 1) return { list: [] };
        if (oid === "1") return { list: [{ rpid: "r1", mid: "10", name: "老朋友", at: 110, rcount: 2 }, { rpid: "r2", mid: "1", at: 111, rcount: 0 }, { rpid: "r5", mid: "20", name: "测试UP", at: 115, rcount: 0 }, { rpid: "r6", mid: "20", at: 116, rcount: 0 }] };
        if (oid === "f1") return { list: [{ rpid: "r3", mid: "20", name: "测试UP", at: 600, rcount: 0 }, { rpid: "r4", mid: "10", at: 610, rcount: 0 }, { rpid: "r7", mid: "20", at: 620, rcount: 0 }] };
        return { list: [] };
      },
      subReplies: async () => ({ list: [{ mid: "11", name: "路人", at: 120 }, { mid: "10", at: 130 }, { mid: "20", name: "测试UP", at: 125 }] }),
      forwards: async () => ({ items: [{ dynId: "f1", mid: "20", name: "测试UP" }, { dynId: "f2", mid: "21", name: "转发者" }], hasMore: false }),
      dynDetail: async (id) => (id === "f1" ? { at: 500, comments: 2, commentType: 17, commentOid: "f1" } : { at: 510, comments: 0 }),
      msgfeed: async (kind, cursor) => {
        if (kind === "reply") return cursor ? { items: [{ users: [{ mid: "10" }], at: 700 }], cursor: null } : { items: [{ users: [{ mid: "12", name: "回复者" }], at: 800 }], cursor: { id: 1, time: 2 } };
        if (kind === "like") return { items: [{ users: [{ mid: "10" }, { mid: "13" }], at: 900 }], cursor: null };
        return { items: [{ users: [{ mid: "14" }], at: 300 }], cursor: null };
      },
      sessions: async (endTs) => (endTs ? { list: [{ talker: "31", ts: 5 }], hasMore: false } : { list: [{ talker: "30", ts: 9 }, { talker: "844424930131966", ts: 8, system: true }], hasMore: true }),
      userCards: async (uids) => uids.map((mid) => ({ mid, name: "私信" + mid, face: "", sign: "", ov: "" })),
      sessionMsgs: async (t, endSeq) => {
        if (t === "31") return { list: [], hasMore: false };
        if (!endSeq) return { list: [{ seq: 30, at: 1000 }, { seq: 20, at: 990 }, { seq: 10, at: 980 }], hasMore: true, minSeq: 10 };
        return { list: [{ seq: 10, at: 980 }, { seq: 5, at: 970 }], hasMore: false, minSeq: 5 };
      }
    };
    // Kill the first worker on its first PM page, after everything before it is saved.
    let killed = false;
    const w1 = worker(st, { ...api, sessionMsgs: async () => { killed = true; return never(); } });
    await w1.Jobs.start("interactions");
    await until(() => killed);
    assert.equal(st.data.bs_jobs.interactions.cursor.phase, "pm");
    const w2 = worker(st, api);
    await w2.Jobs.resumeAll();
    await w2.Jobs.wait("interactions");

    const I = st.data.bs_interactions;
    assert.deepEqual(I.videos.map((v) => [v.bvid, v.play]), [["BV1", 125000], ["BV2", 50]]);
    const b = I.byMid;
    assert.equal(b["1"], undefined, "I am not my own contact");
    // 老朋友: 1 top comment + 1 sub-comment on my video, 1 comment under 测试UP's repost; 1 reply notice, 1 like.
    assert.deepEqual([b["10"].comments, b["10"].repostComments, b["10"].reply, b["10"].like, b["10"].last], [2, 1, 1, 1, 900]);
    assert.deepEqual(b["10"].span.comments, { first: 110, last: 130 });
    assert.deepEqual(b["10"].span.reply, { first: 700, last: 700 });
    assert.equal(b["11"].comments, 1);
    assert.deepEqual(b["20"].reposts, [{ bvid: "BV1", dynId: "f1", at: 500 }]);
    // 测试UP: 3 under my video (2 top-level + 1 sub-reply), 2 under his own repost of it.
    assert.deepEqual([b["20"].comments, b["20"].repostComments], [3, 2]);
    assert.deepEqual(b["20"].span.repostComments, { first: 600, last: 620 });
    assert.deepEqual(b["21"].reposts, [{ bvid: "BV1", dynId: "f2", at: 510 }]);
    assert.equal(b["14"].atMe, 1);
    assert.deepEqual(b["30"].pm, { count: 4, first: 970, last: 1000 }, "the boundary message is not counted twice");
    assert.equal(b["31"], undefined);
    assert.equal(b["844424930131966"], undefined, "B站 service accounts (创作助手) are not counted as 私信");
    assert.equal(st.data.bs_people["30"].name, "私信30");
    assert.equal(st.data.bs_people["10"].sign, "keep me", "interactions never overwrite a known profile");
    assert.equal(st.data.bs_people["20"].name, "测试UP");
    assert.ok(st.data.bs_jobs.interactions.finishedAt);
    assert.doesNotMatch(JSON.stringify(st.data), /"content"/);

    // Running it again starts over instead of adding to the old counts, and keeps the old result until it is done.
    const writes = [];
    const set = st.set;
    st.set = async (obj) => { if (obj.bs_interactions) writes.push(st.data.bs_jobs.interactions.step); return set(obj); };
    await w2.Jobs.start("interactions");
    await w2.Jobs.wait("interactions");
    st.set = set;
    assert.equal(writes.length, 1, "one write, at the end");
    assert.equal(st.data.bs_interactions.byMid["10"].comments, 2);
  }

  // ---- order: 关注的关注 waits for 投稿内容; the queue mark survives a killed worker; an error leaves it queued ----
  {
    const l1 = ["a", "b"];
    const st = makeStorage({ bs_followings: { at: 1, list: l1 }, bs_circle: {}, bs_me: { mid: "1" } });
    const noFeed = async () => ({ items: [], offset: "", hasMore: false });
    let gate, release;
    const reset = () => (gate = new Promise((r) => (release = r)));
    reset();
    const circleAsked = [];
    const arc = [];
    const api = {
      feedVideo: noFeed,
      followings: async (mid) => { circleAsked.push(mid); await gate; return { code: 0, total: 1, list: [{ mid: "z", name: "z" }] }; },
      arcSearch: async (mid) => { arc.push(mid); await gate; return { code: 0, count: 0, tlist: {}, v: [] }; }
    };
    const w1 = worker(st, api);
    await w1.Jobs.start("circle");
    await until(() => circleAsked.length);
    // Two starts at once run the job once.
    await Promise.all([w1.Jobs.start("content"), w1.Jobs.start("content")]);
    assert.equal(st.data.bs_jobs.circle.running, false);
    assert.equal(st.data.bs_jobs.circle.after, "content", "circle paused and queued behind content");
    assert.equal(st.data.bs_jobs.content.running, true);
    await until(() => arc.length);
    assert.equal(arc.length, 1);
    // Starting circle while content runs only queues it.
    await w1.Jobs.start("circle");
    assert.equal(st.data.bs_jobs.circle.running, false);
    // The worker dies; the next one resumes content, then runs the queued circle.
    reset();
    const w2 = worker(st, api);
    await w2.Jobs.resumeAll();
    assert.equal(st.data.bs_jobs.circle.running, false, "resumeAll does not start a queued job early");
    release();
    await w2.Jobs.wait("content");
    await until(() => st.data.bs_jobs.circle.finishedAt);
    assert.ok(st.data.bs_jobs.content.finishedAt);
    assert.ok(st.data.bs_jobs.circle.finishedAt);
    assert.ok(st.data.bs_jobs.content.lastFinishedAt);
    assert.equal(st.data.bs_jobs.circle.after, null);

    // Content throttled: circle stays queued, not started into the same wall.
    const st2 = makeStorage({ bs_followings: { at: 1, list: l1 }, bs_circle: {}, bs_me: { mid: "1" }, bs_jobs: { circle: { done: 1, after: "content" } } });
    const w3 = worker(st2, { feedVideo: noFeed, arcSearch: async () => { throw Object.assign(new Error("限流"), { code: "THROTTLED" }); } });
    await w3.Jobs.start("content");
    await w3.Jobs.wait("content");
    await tick();
    assert.equal(st2.data.bs_jobs.circle.after, "content");
    assert.equal(w3.Jobs.wait("circle"), undefined);
    // Stopping a queued job clears the mark.
    await w3.Jobs.stop("circle");
    assert.equal(st2.data.bs_jobs.circle.after, null);
  }

  // ---- a 0.1.0 circle paused for content (no `after` key) gets queued on resume ----
  {
    const st = makeStorage({ bs_followings: { at: 1, list: ["a"] }, bs_me: { mid: "1" }, bs_jobs: { circle: { running: false, done: 116, total: 952, finishedAt: null, error: null }, content: { running: true, cursor: { phase: "arc" } } } });
    const w = worker(st, { feedVideo: never, arcSearch: never });
    await w.Jobs.resumeAll();
    assert.equal(st.data.bs_jobs.circle.after, "content");
    await w.Jobs.stop("content");
    const st2 = makeStorage({ bs_jobs: { mine: { finishedAt: 5 } } });
    await worker(st2, {}).Jobs.resumeAll();
    assert.equal(st2.data.bs_jobs.mine.lastFinishedAt, 5, "migrated from finishedAt");
  }

  // ---- a stop lands mid back-off; a queue pause shows on every running job ----
  {
    const st = makeStorage({ bs_followings: { at: 1, list: ["a"] }, bs_me: { mid: "1" } });
    const B = { feedVideo: never };
    const w = worker(st, B);
    await w.Jobs.start("content");
    await until(() => B.onHold);
    B.onHold({ until: 123, why: "throttled", n: 1, of: 2 });
    await until(() => st.data.bs_jobs.content.hold);
    assert.deepEqual(st.data.bs_jobs.content.hold, { until: 123, why: "throttled", n: 1, of: 2 });
    await w.Jobs.stop("content");
    await w.Jobs.wait("content");
    assert.equal(st.data.bs_jobs.content.running, false);
    assert.equal(st.data.bs_jobs.content.hold, null);
  }

  // ---- a finished 关注的关注 sends 投稿内容 after the second-layer accounts it found ----
  {
    const l1 = ["a", "b", "c", "d", "e"];
    const t = Math.floor(Date.now() / 1000);
    const st = makeStorage({
      bs_followings: { at: 1, list: l1 }, bs_me: { mid: "1" },
      bs_content: Object.fromEntries(l1.map((m) => [m, { code: 0 }])),
      bs_last_post: { at: t, since: t - 100 * 86400, map: {} }
    });
    const arc = [];
    const w = worker(st, { followings: async () => ({ code: 0, total: 1, list: [{ mid: "L2", name: "L2" }] }), arcSearch: async (mid) => { arc.push(mid); return { code: 0, count: 0, tlist: {}, v: [] }; } });
    await w.Jobs.start("circle");
    await w.Jobs.wait("circle");
    await until(() => st.data.bs_jobs.content?.finishedAt);
    assert.deepEqual(arc, ["L2"]);
  }

  // ---- interactions 更新: only changed units are fetched again, and the result equals a fresh full scan ----
  {
    // A small mutable world: videos with comment areas and reposts, notifications, PM sessions.
    const W = {
      videos: [
        { bvid: "V1", aid: "1", dynId: "d1", at: 100, commentType: 1, commentOid: "1", forwards: 2 },
        { bvid: "V2", aid: "2", dynId: "d2", at: 200, commentType: 1, commentOid: "2", forwards: 0 }
      ],
      comments: { 1: [["10", 110], ["11", 111]], 2: [["12", 210]], f1: [["20", 600]], f2: [] },
      reposts: { d1: [["f1", "20", 500], ["f2", "21", 510]] },
      feed: { reply: [["r2", 800, ["12"]], ["r1", 700, ["10"]]], like: [["l2", 900, ["10", "13"]], ["l1", 850, ["11"]]], at: [["a1", 300, ["14"]]] },
      sessions: [["30", 9000], ["31", 8000]],
      msgs: { 30: [[3, 1000], [2, 990], [1, 980]], 31: [[1, 970]] }
    };
    const count = (k) => W.comments[k].length;
    let calls = [];
    const api = {
      spaceDynamics: async () => ({ items: W.videos.map((v) => ({ ...v, comments: count(v.commentOid) })), hasMore: false }),
      replies: async (type, oid, pn) => { calls.push("replies"); return { list: pn > 1 ? [] : W.comments[oid].map(([mid, at], i) => ({ rpid: oid + i, mid, name: mid, at, rcount: 0 })) }; },
      subReplies: async () => ({ list: [] }),
      forwards: async (id) => { calls.push("forwards"); return { items: (W.reposts[id] || []).map(([dynId, mid]) => ({ dynId, mid, name: mid })), hasMore: false }; },
      dynDetail: async (id) => { calls.push("dynDetail"); const r = Object.values(W.reposts).flat().find((x) => x[0] === id); return { at: r[2], comments: count(id), commentType: 17, commentOid: id }; },
      msgfeed: async (kind, cursor) => {
        calls.push("msgfeed");
        const all = [...W.feed[kind]].sort((a, b) => b[1] - a[1]);
        const i = cursor?.id || 0; // one item per page
        return { items: all.slice(i, i + 1).map(([id, at, mids]) => ({ id, at, users: mids.map((mid) => ({ mid, name: mid })) })), cursor: i + 1 < all.length ? { id: i + 1, time: 1 } : null };
      },
      sessions: async () => { calls.push("sessions"); return { list: W.sessions.map(([talker, ts]) => ({ talker, ts })), hasMore: false }; },
      userCards: async (uids) => uids.map((mid) => ({ mid, name: mid })),
      sessionMsgs: async (t) => { calls.push("pm:" + t); return { list: W.msgs[t].map(([seq, at]) => ({ seq, at })), hasMore: false }; }
    };
    const full = async () => {
      const st = makeStorage({ bs_me: { mid: "1" } });
      const w = worker(st, api);
      await w.Jobs.start("interactions");
      await w.Jobs.wait("interactions");
      return st;
    };
    const strip = (st) => { const { at, ...rest } = st.data.bs_interactions; return rest; };

    const st = await full();
    // Changes: a new comment on V1, a new comment under repost f1, a new reply, a like on l1 by 15, a new PM in 30, a new session 32.
    W.comments[1].push(["15", 120]);
    W.comments.f1.push(["16", 620]);
    W.feed.reply.push(["r3", 950, ["17"]]);
    W.feed.like[1] = ["l1", 960, ["15", "11"]];
    W.msgs[30].unshift([4, 1100]);
    W.sessions = [["32", 9900], ["30", 9500], ["31", 8000]];
    W.msgs[32] = [[1, 1200]];

    calls = [];
    const w = worker(st, api);
    await w.Jobs.start("interactions");
    await w.Jobs.wait("interactions");
    const inc = calls;
    calls = [];
    const ref = await full();
    assert.deepEqual(strip(st), strip(ref), "更新 gives the same counts as a full scan");
    assert.equal(st.data.bs_interactions.byMid["16"].repostComments, 1);
    assert.equal(st.data.bs_interactions.byMid["15"].like, 1);
    const n = (list, k) => list.filter((c) => c === k).length;
    assert.equal(n(inc, "replies"), 4, "only V1 and repost f1 are re-scanned (2 pages each)");
    assert.equal(n(inc, "forwards"), 0, "repost list reused");
    assert.equal(n(inc, "dynDetail"), 2, "each repost's comment count checked");
    assert.deepEqual(inc.filter((c) => c.startsWith("pm:")).sort(), ["pm:30", "pm:32"], "unchanged session 31 not counted again");
    assert.ok(n(inc, "msgfeed") < n(calls, "msgfeed"), "notifications stop at the first known item");
    assert.equal(st.data.bs_interactions_work.prev, null);

    // 完整重扫 fetches everything again.
    calls = [];
    await w.Jobs.start("interactions", { full: true });
    await w.Jobs.wait("interactions");
    assert.ok(calls.includes("pm:31") && calls.includes("forwards"));
    assert.deepEqual(strip(st), strip(ref));
  }

  // ---- fans diff: who stopped following me ----
  {
    const { Jobs } = worker(makeStorage(), {});
    const f = (mid, followTime) => ({ mid, followTime, mutual: false });
    const old = { at: 1, list: [f("a", 50), f("b", 40), f("c", 30)], lost: [{ mid: "z", at: 5, followTime: 1 }, { mid: "d", at: 5, followTime: 2 }] };
    const all = JSON.parse(JSON.stringify(Jobs.fansDiff(old, [f("a", 50), f("d", 60)], 2, 99)));
    assert.deepEqual(all.lost.map((x) => [x.mid, x.at, x.followTime]), [["b", 99, 40], ["c", 99, 30], ["z", 5, 1]], "b, c left; d came back");
    // Only part of the list (total 10): c followed before the oldest returned fan, so it may just be cut off.
    const part = Jobs.fansDiff(old, [f("a", 50), f("x", 35)], 10, 99);
    assert.deepEqual([...part.lost.map((x) => x.mid)], ["b", "z", "d"]);
    assert.deepEqual([...Jobs.fansDiff(null, [f("a", 1)], 1, 99).lost], [], "first sync loses nobody");
  }

  // ---- watchdog: a job whose request never settles is restarted from its cursor, once ----
  {
    const l1 = ["a", "b", "c"];
    const t = Math.floor(Date.now() / 1000);
    const st = makeStorage({ bs_followings: { at: 1, list: l1 }, bs_me: { mid: "1" }, bs_last_post: { at: t, since: t - 100 * 86400, map: {} } });
    const asked = [];
    let hang = true;
    const w = worker(st, { arcSearch: async (mid) => { asked.push(mid); if (mid === "b" && hang) return never(); return { code: 0, count: 0, tlist: {}, v: [] }; } });
    await w.Jobs.start("content");
    await until(() => asked.includes("b"));
    // Fresh beat: left alone.
    await w.Jobs.resumeAll();
    assert.deepEqual(asked, ["a", "b"]);
    // A paused queue is not a hang either.
    st.data.bs_jobs.content.beat = t - 600;
    st.data.bs_jobs.content.hold = { until: t + 30 };
    await w.Jobs.resumeAll();
    assert.deepEqual(asked, ["a", "b"]);
    // 10 minutes without a beat: restarted; two checks at once restart it once.
    st.data.bs_jobs.content.hold = null;
    hang = false;
    await Promise.all([w.Jobs.resumeAll(), w.Jobs.resumeAll()]);
    await w.Jobs.wait("content");
    assert.deepEqual(asked, ["a", "b", "b", "c"], "resumed after a, b asked again once");
    assert.ok(st.data.bs_jobs.content.finishedAt);
    assert.deepEqual(Object.keys(st.data.bs_content).sort(), ["a", "b", "c"]);
  }

  // ---- mine vs. what is stored: unfollowed on B站, followed again, mid-sync follows and unfollows, cut lists ----
  {
    const { Jobs } = worker(makeStorage(), {});
    const live = new Set(["t1", "t2"]);
    const cur = { list: ["a", "b", "c", "n"], followTime: { a: 10, b: 10, c: 10, n: 500 } };
    const fresh = { list: ["a", "x", "y"], followTime: { a: 10, x: 300, y: 50 }, special: { x: 1, z: 1 }, groups: {}, complete: true };
    const unf = { c: { at: 100, tagIds: ["t1"], source: "app" }, x: { at: 200, tagIds: ["t1", "gone"] }, y: { at: 200, tagIds: ["t2"] } };
    const d = JSON.parse(JSON.stringify(Jobs.followDiff(cur, fresh, unf, { b: ["t2"] }, live, 400, 999)));
    assert.deepEqual(d.followings.list, ["n", "a", "x"], "n followed here mid-sync is kept; y (followed before its unfollow) is left out");
    assert.deepEqual(d.gone, { b: { at: 999, tagIds: ["t2"], source: "bili" } }, "b left on B站; c was already recorded");
    assert.deepEqual(d.back, ["x"], "x followed again after its unfollow");
    assert.deepEqual(d.restore, { x: ["t1"] }, "only tags that still exist come back");
    assert.deepEqual(d.followings.special, { x: 1 });
    assert.equal(d.followings.followTime.n, 500);
    // No followTime: the unfollow record stays.
    assert.deepEqual(Jobs.followDiff({ list: [] }, { list: ["y"], followTime: {}, complete: true }, { y: { at: 1 } }, {}, live, 0, 9).back.length, 0);
    // A cut list (fewer than total) marks nobody as gone.
    assert.deepEqual(JSON.parse(JSON.stringify(Jobs.followDiff(cur, { ...fresh, complete: false }, unf, {}, live, 400, 999).gone)), {});
  }
  {
    const fol = (mids) => mids.map((mid) => ({ mid, name: "n" + mid, face: "f", mtime: 10 }));
    const st = makeStorage({
      bs_followings: { at: 1, list: ["a", "b", "c", "d"], followTime: {} },
      bs_unfollowed: { e: { at: 5, tagIds: ["t"], source: "bili" } },
      bs_up_tag_map: { b: ["t"], a: ["t"] },
      bs_up_tags: [{ id: "t" }]
    });
    let page = ["a", "b", "c", "e"];
    let cut = false;
    const api = {
      nav: async () => ({ isLogin: true, mid: "1" }),
      relationStat: async () => ({ following: 4, follower: 0 }),
      userCards: async () => [],
      followings: async (mid, pn) => {
        // The 关注 page unfollows c while the sync runs (background bs-follow act 2 already wrote both keys).
        if (pn === 1 && !cut) {
          const f = st.data.bs_followings;
          st.data.bs_followings = { ...f, list: f.list.filter((m) => m !== "c") };
          st.data.bs_unfollowed.c = { at: Math.floor(Date.now() / 1000), tagIds: [], source: "app" };
        }
        return { code: 0, total: cut ? 9 : page.length, list: pn === 1 ? fol(page).map((x) => (x.mid === "e" ? { ...x, mtime: 50 } : x)) : [] };
      },
      followers: async () => ({ total: 0, list: [] }),
      feedVideo: async () => ({ items: [], offset: "", hasMore: false }),
      arcSearch: async () => ({ code: 0, count: 0, tlist: {}, v: [] })
    };
    const { Jobs } = worker(st, api);
    await Jobs.start("mine");
    await Jobs.wait("mine");
    await Jobs.wait("content");
    const d = st.data;
    assert.deepEqual(d.bs_followings.list, ["a", "b", "e"], "c unfollowed mid-sync stays out; e followed again on B站");
    assert.equal(d.bs_unfollowed.d.source, "bili", "d disappeared from the list: unfollowed on B站");
    assert.equal(d.bs_unfollowed.c.source, "app");
    assert.equal(d.bs_unfollowed.e, undefined, "e's followTime is newer than its unfollow");
    assert.deepEqual(d.bs_up_tag_map, { a: ["t"], b: ["t"], e: ["t"] }, "e gets its tags back");

    // B站 unfollow of b with tags: the tags move into the record. Then a cut list (total 9, 2 returned) changes nothing.
    page = ["a", "e"];
    await Jobs.start("mine");
    await Jobs.wait("mine");
    await Jobs.wait("content");
    assert.deepEqual(d.bs_unfollowed.b.tagIds, ["t"]);
    assert.equal(d.bs_up_tag_map.b, undefined);
    cut = true;
    page = ["a"];
    await Jobs.start("mine");
    await Jobs.wait("mine");
    await Jobs.wait("content");
    assert.equal(d.bs_unfollowed.e, undefined, "a cut list does not mark e as gone");
  }

  // ---- bs_people: a closed account keeps its known name and face ----
  {
    const { Jobs } = worker(makeStorage(), {});
    const old = { mid: "1", name: "老名字", face: "https://i0.hdslb.com/bfs/face/abc.jpg", sign: "签名", ov: "" };
    const m = Jobs.mergePerson(old, { mid: "1", name: "账号已注销", face: "https://i0.hdslb.com/bfs/face/member/noface.jpg", sign: "", ov: "" });
    assert.deepEqual([m.name, m.face, m.sign, m.gone], ["老名字", old.face, "签名", true]);
    assert.equal(Jobs.mergePerson(old, { mid: "1", name: "", face: "", sign: "", ov: "" }).name, "老名字");
    const back = Jobs.mergePerson(m, { mid: "1", name: "新名字", face: "https://x/new.jpg", sign: "", ov: "" });
    assert.deepEqual([back.name, back.face, back.gone], ["新名字", "https://x/new.jpg", undefined]);
    assert.equal(Jobs.mergePerson(undefined, { mid: "2", name: "账号已注销", face: "" }).gone, true);
    // Through a job's buffer.
    const st = makeStorage({ bs_me: { mid: "1", following: 1 }, bs_people: { 7: old }, bs_jobs: { mine: { cursor: { phase: "followings" } } } });
    const w = worker(st, {
      followings: async () => ({ code: 0, total: 1, list: [{ mid: "7", name: "账号已注销", face: "http://i0.hdslb.com/bfs/face/member/noface.jpg", mtime: 1 }] }),
      followers: async () => ({ total: 0, list: [] }),
      feedVideo: async () => ({ items: [], offset: "", hasMore: false }),
      arcSearch: async () => ({ code: 0, count: 0, tlist: {}, v: [] })
    });
    await w.Jobs.start("mine");
    await w.Jobs.wait("mine");
    await w.Jobs.wait("content");
    assert.deepEqual([st.data.bs_people[7].name, st.data.bs_people[7].face, st.data.bs_people[7].gone], ["老名字", old.face, true]);
  }

  // ---- content: only gone accounts are stored with their code; temporary errors are retried next run ----
  {
    const st = makeStorage({ bs_followings: { at: 1, list: ["a", "b", "c", "d", "old"] }, bs_me: { mid: "1" }, bs_content: { old: { code: -403, count: 0 } } });
    const errs = { a: -404, b: -403, c: -509, d: null };
    let fixed = false;
    const asked = [];
    const api = {
      feedVideo: async () => ({ items: [], offset: "", hasMore: false }),
      arcSearch: async (mid) => {
        asked.push(mid);
        if (!fixed && mid in errs) throw Object.assign(new Error("x"), errs[mid] === null ? {} : { code: errs[mid] });
        return { code: 0, count: 1, tlist: {}, v: [] };
      }
    };
    const { Jobs } = worker(st, api);
    await Jobs.start("content");
    await Jobs.wait("content");
    assert.equal(st.data.bs_content.a.code, -404);
    assert.deepEqual(Object.keys(st.data.bs_content).sort(), ["a", "old"], "temporary errors are not stored");
    assert.equal(st.data.bs_content.old.code, 0, "an old temporary record is asked again");
    assert.equal(st.data.bs_jobs.content.skipped, 3);
    assert.ok(st.data.bs_jobs.content.finishedAt);
    fixed = true;
    asked.length = 0;
    await Jobs.start("content");
    await Jobs.wait("content");
    assert.deepEqual(asked, ["b", "c", "d"], "the skipped ones are retried, the gone one is not");
    assert.equal(st.data.bs_jobs.content.skipped, 0);
  }

  console.log("jobs.selftest ok");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
