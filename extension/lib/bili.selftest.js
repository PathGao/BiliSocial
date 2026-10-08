// Run: /usr/local/bin/node extension/lib/bili.selftest.js
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("assert/strict");

function load() {
  const ctx = vm.createContext({ TextEncoder, URLSearchParams, setTimeout, clearTimeout, AbortController, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "bili.js"), "utf8"), ctx);
  const B = ctx.Bili;
  // Virtual clock: sleep advances time instantly.
  let t = 1_000_000;
  const sleeps = [];
  const calls = [];
  B.io.now = () => t;
  B.io.sleep = async (ms) => { sleeps.push(ms); t += ms; };
  B.io.random = () => 0.5;
  B.io.cookie = async () => "csrf-token";
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  return { B, sleeps, calls, json, setFetch: (fn) => (B.io.fetch = async (url, init) => { calls.push({ url, init, at: t }); return fn(url, init); }) };
}

(async () => {
  // WBI: w_rid is md5(sorted query + mixin key), with !'()* stripped from values (vector from MoonDigest sites.selftest.js).
  {
    const { B } = load();
    const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
    const key = B.mixinKey("https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png", "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png");
    assert.equal(key.length, 32);
    const query = "aid=116420927166252&bvid=BV1g1dLBPEHV&cid=37589944385&foo=abcd%20%E4%B8%AD&wts=1700000000";
    assert.equal(B.wbiSign({ bvid: "BV1g1dLBPEHV", cid: 37589944385, aid: 116420927166252, foo: "a!b'(c)*d 中" }, key, 1700000000), `${query}&w_rid=${md5(query + key)}`);
    for (const n of [0, 40, 41, 48, 1000]) assert.equal(B.md5("a".repeat(n)), md5("a".repeat(n)));
  }

  // arcSearch fetches the nav key once, signs, and the key is cached for 10 minutes.
  {
    const { B, calls, json, setFetch } = load();
    setFetch((url) =>
      url.includes("/nav")
        ? json({ code: 0, data: { wbi_img: { img_url: "https://x/7cd084941338484aae1ad9425b84077c.png", sub_url: "https://x/4932caff0ff746eab6f01bf08b70ac45.png" } } })
        : json({ code: 0, data: { page: { count: 2 }, list: { tlist: { 36: { name: "知识", count: 2 } }, vlist: [{ title: "t", typeid: 201, created: 5, play: 9, length: "1:00" }] } } })
    );
    const r = await B.arcSearch("42");
    await B.arcSearch("43");
    assert.deepEqual(JSON.parse(JSON.stringify(r)), { code: 0, count: 2, tlist: { 知识: 2 }, v: [{ t: "t", tid: 201, c: 5, p: 9, len: "1:00" }] });
    assert.equal(calls.filter((c) => c.url.includes("/nav")).length, 1);
    assert.match(calls[1].url, /arc\/search\?.*mid=42.*&w_rid=[0-9a-f]{32}$/);
  }

  // Throttle: requests are spaced by gap + jitter (1000 + 0.5 * 500).
  {
    const { B, calls, json, setFetch } = load();
    setFetch(() => json({ code: 0, data: { following: 1, follower: 2 } }));
    await Promise.all([B.relationStat(1), B.relationStat(2), B.relationStat(3)]);
    assert.deepEqual(calls.map((c, i) => (i ? c.at - calls[i - 1].at : 0)), [0, 1250, 1250]);
  }

  // Risk control: back off 90 s and retry; recovers on the third try.
  {
    const { B, sleeps, json, setFetch } = load();
    let n = 0;
    setFetch(() => (++n < 3 ? json({ code: -352, message: "风控校验失败" }) : json({ code: 0, data: { following: 7, follower: 8 } })));
    assert.deepEqual({ ...(await B.relationStat(1)) }, { following: 7, follower: 8 });
    assert.equal(sleeps.filter((s) => s === 90000).length, 2);
  }

  // A risk answer pauses the whole queue (another job's call waits too) and reports the pause through onHold.
  {
    const { B, calls, json, setFetch } = load();
    const holds = [];
    let other;
    B.onHold = (h) => { holds.push(h); other = B.relationStat(2); };
    let n = 0;
    setFetch(() => (++n === 1 ? json({ code: -352 }) : json({ code: 0, data: { following: 1, follower: 2 } })));
    await B.relationStat(1);
    await other;
    assert.deepEqual(holds.map((h) => [h.why, h.n, h.of]), [["throttled", 1, 2]]);
    assert.ok(calls.slice(1).every((c) => c.at - calls[0].at >= 90000), "every call waited out the pause");
    assert.equal(holds[0].until, Math.ceil((calls[0].at + 90000) / 1000));
  }

  // A request that never answers times out (aborted) and is retried like a dropped connection.
  {
    const { B, sleeps, json, setFetch } = load();
    let first = true, aborted = false;
    B.io.timeout = () => (first ? { p: Promise.reject(new TypeError("30 秒没有回应")), cancel() {} } : { p: new Promise(() => {}), cancel() {} });
    setFetch((url, init) => {
      if (first) { first = false; init.signal.addEventListener("abort", () => (aborted = true)); return new Promise(() => {}); }
      return json({ code: 0, data: { following: 1, follower: 2 } });
    });
    assert.equal((await B.relationStat(1)).follower, 2);
    assert.ok(aborted, "the hung request is aborted");
    assert.ok(sleeps.includes(5000), "retried after the network pause");
  }

  // A dropped connection is retried after 5/15/30 s; a fourth failure stops with code NETWORK.
  {
    const { B, sleeps, json, setFetch } = load();
    let fails = 2;
    setFetch(() => { if (fails-- > 0) throw new TypeError("Failed to fetch"); return json({ code: 0, data: { following: 1, follower: 2 } }); });
    assert.equal((await B.relationStat(1)).follower, 2, "recovers after two drops");
    assert.ok(sleeps.includes(5000) && sleeps.includes(15000));
    const t2 = load();
    t2.setFetch(() => { throw new TypeError("Failed to fetch"); });
    await assert.rejects(t2.B.relationStat(1), (e) => e.code === "NETWORK");
  }

  // 特别关注: followings marks special (-10) and keeps own groups; copyUsers / moveUsers post the group form with csrf.
  {
    const { B, calls, json, setFetch } = load();
    setFetch((url) => url.includes("followings")
      ? json({ code: 0, data: { total: 2, list: [{ mid: 1, special: 1, tag: [-10, 3] }, { mid: 2, special: 0, tag: null }] } })
      : json({ code: 0, data: {} }));
    const r = await B.followings(9, 1);
    assert.deepEqual(r.list.map((x) => [x.special, [...x.groups]]), [[true, [3]], [false, []]]);
    await B.copyUsers("5", -10);
    await B.moveUsers("5", -10, [3, 4]);
    assert.match(calls[1].url, /tags\/copyUsers$/);
    assert.equal(calls[1].init.body, "fids=5&tagids=-10&csrf=csrf-token");
    assert.equal(calls[2].init.body, "fids=5&beforeTagids=-10&afterTagids=3%2C4&csrf=csrf-token");
  }

  // Three strikes in a row (HTTP 412 counts) → THROTTLED, no fourth request.
  {
    const { B, calls, json, setFetch } = load();
    setFetch(() => json(null, 412));
    await assert.rejects(B.relationStat(1), (e) => e.code === "THROTTLED" && /限流/.test(e.message));
    assert.equal(calls.length, 3);
  }

  // followings returns hidden lists as data; other errors throw with the numeric code.
  {
    const { B, json, setFetch } = load();
    setFetch((url) => (url.includes("followings") ? json({ code: 22115, message: "用户已设置隐私" }) : json({ code: -404, message: "啥都木有" })));
    assert.equal((await B.followings("9", 1)).code, 22115);
    await assert.rejects(B.relationStat(1), (e) => e.code === -404);
  }

  // Shapes: like feed with several users and a cursor; counts with 万.
  {
    const { B, calls, json, setFetch } = load();
    setFetch(() => json({ code: 0, data: { total: { cursor: { is_end: false, id: 5, time: 77 }, items: [{ users: [{ mid: 1, nickname: "a", avatar: "fa" }, { mid: 2, nickname: "b" }], like_time: 70 }] } } }));
    const r = await B.msgfeed("like", { id: 9, time: 99 });
    assert.equal(r.items[0].users.map((u) => u.mid).join(), "1,2");
    assert.equal(r.items[0].at, 70);
    assert.deepEqual({ ...r.cursor }, { id: 5, time: 77 });
    assert.match(calls[0].url, /msgfeed\/like\?id=9&like_time=99/);
    assert.equal(B.parseCount("12.5万"), 125000);
    assert.equal(B.parseCount("2505"), 2505);
  }

  // PM messages keep only sequence, time and sender; the text is dropped.
  {
    const { B, json, setFetch } = load();
    setFetch(() => json({ code: 0, data: { messages: [{ msg_seqno: 3, timestamp: 9, sender_uid: 5, content: "{\"content\":\"secret\"}" }], has_more: 0, min_seqno: 3 } }));
    const r = await B.sessionMsgs("5");
    assert.doesNotMatch(JSON.stringify(r), /secret/);
    assert.deepEqual({ ...r.list[0] }, { seq: 3, at: 9, sender: "5" });
  }

  // POST carries the csrf cookie and never retries.
  {
    const { B, calls, json, setFetch } = load();
    setFetch(() => json({ code: 0, data: null }));
    await B.modifyRelation("123", 2);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, "fid=123&act=2&re_src=11&csrf=csrf-token");
    await assert.rejects(B.modifyRelation("123", 3));
  }

  // WBI rejection (-403): the mixin key is fetched again and the call signed again, once.
  {
    const { B, calls, json, setFetch } = load();
    let n = 0;
    setFetch((url) =>
      url.includes("/nav")
        ? json({ code: 0, data: { wbi_img: { img_url: `https://x/${n ? "4932caff0ff746eab6f01bf08b70ac45" : "7cd084941338484aae1ad9425b84077c"}.png`, sub_url: "https://x/4932caff0ff746eab6f01bf08b70ac45.png" } } })
        : n++ === 0 ? json({ code: -403, message: "访问权限不足" }) : json({ code: 0, data: { page: { count: 0 }, list: {} } })
    );
    const r = await B.arcSearch("42");
    assert.equal(r.count, 0);
    assert.deepEqual(calls.map((c) => (c.url.includes("/nav") ? "nav" : "arc")), ["nav", "arc", "nav", "arc"]);
    assert.notEqual(new URL(calls[1].url).searchParams.get("w_rid"), new URL(calls[3].url).searchParams.get("w_rid"), "signed with the new key");
    // A second -403 is the account's answer.
    n = 0;
    setFetch((url) => (url.includes("/nav") ? json({ code: 0, data: { wbi_img: { img_url: "https://x/a.png", sub_url: "https://x/b.png" } } }) : json({ code: -403, message: "x" })));
    await assert.rejects(B.arcSearch("42"), (e) => e.code === -403);
  }

  // A risk answer on a signed call drops the key: the retry after the pause is signed with a fresh one.
  {
    const { B, calls, json, setFetch } = load();
    let arc = 0;
    setFetch((url) =>
      url.includes("/nav")
        ? json({ code: 0, data: { wbi_img: { img_url: "https://x/7cd084941338484aae1ad9425b84077c.png", sub_url: "https://x/4932caff0ff746eab6f01bf08b70ac45.png" } } })
        : arc++ === 0 ? json({ code: -352, message: "风控" }) : json({ code: 0, data: { page: { count: 0 }, list: {} } })
    );
    await B.arcSearch("42");
    assert.deepEqual(calls.map((c) => (c.url.includes("/nav") ? "nav" : "arc")), ["nav", "arc", "nav", "arc"]);
  }

  // A success answer with an empty list where one is expected: wait 1.5 s and ask once more (only once).
  {
    const { B, calls, sleeps, json, setFetch } = load();
    let k = 0;
    setFetch(() => json({ code: 0, data: { total: 3, list: k++ ? [{ mid: 7, uname: "a", mtime: 1 }] : [] } }));
    assert.equal((await B.followings(1, 1)).list.length, 1);
    assert.equal(calls.length, 2);
    assert.ok(sleeps.includes(1500));
    k = 0;
    calls.length = 0;
    assert.equal((await B.followers(1, 1)).list.length, 1);
    assert.equal(calls.length, 2);
    // Page 2 empty is the end of the list, not a retry.
    calls.length = 0;
    setFetch(() => json({ code: 0, data: { total: 3, list: [] } }));
    assert.equal((await B.followings(1, 2)).list.length, 0);
    assert.equal(calls.length, 1);
    // Still empty after the retry: taken as empty.
    calls.length = 0;
    assert.equal((await B.followings(1, 1)).list.length, 0);
    assert.equal(calls.length, 2);
    // Feed page 1 and arc/search with count > 0.
    calls.length = 0;
    k = 0;
    setFetch(() => json({ code: 0, data: { items: k++ ? [{ id_str: "1", modules: { module_author: { mid: 5, pub_ts: 9 } } }] : [], offset: "o", has_more: true } }));
    assert.equal((await B.feedVideo("")).items.length, 1);
    assert.equal(calls.length, 2);
    calls.length = 0;
    k = 0;
    setFetch((url) =>
      url.includes("/nav")
        ? json({ code: 0, data: { wbi_img: { img_url: "https://x/a.png", sub_url: "https://x/b.png" } } })
        : json({ code: 0, data: { page: { count: 4 }, list: { vlist: k++ ? [{ title: "t" }] : [] } } })
    );
    assert.equal((await B.arcSearch("9")).v.length, 1);
    assert.equal(calls.filter((c) => c.url.includes("arc/search")).length, 2);
  }

  // sameFollowings: common follows as data, hidden lists come back as { code }.
  {
    const { B, calls, json, setFetch } = load();
    setFetch(() => json({ code: 0, data: { total: 67, list: [{ mid: 7, uname: "a" }] } }));
    const r = await B.sameFollowings("123456789", 2);
    assert.deepEqual([r.code, r.total, r.list[0].mid, r.list[0].name], [0, 67, "7", "a"]);
    assert.match(calls[0].url, /x\/relation\/same\/followings\?vmid=123456789&pn=2&ps=50$/);
    setFetch(() => json({ code: 22115, message: "用户已设置隐私" }));
    assert.equal((await B.sameFollowings("9", 1)).code, 22115);
  }

  console.log("bili.selftest ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
