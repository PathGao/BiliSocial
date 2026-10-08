// B站 API client for the service worker (importScripts) and node vm selftests. Defines globalThis.Bili.
// Every request goes through one global queue (~1 req/s with jitter). Risk control (HTTP 412, code -352/-412/-799/-509)
// pauses the whole queue 90 s and retries; the third strike in a row throws an error with code "THROTTLED". A dropped
// connection or a request with no answer in 30 s pauses it 5 s .. 5 min (six tries) before throwing "NETWORK". Bili.onHold hears about every pause.
// Endpoint functions return plain data; a B站 code other than 0 throws an error carrying that numeric code,
// except followings() which returns { code } so jobs can record hidden lists (22115).
(() => {
  const API = "https://api.bilibili.com";
  const VC = "https://api.vc.bilibili.com";
  const RISK_CODES = new Set([-352, -412, -799, -509]);

  // Tests replace io and shrink cfg.
  const io = {
    fetch: (...a) => fetch(...a),
    // Rejects after ms unless cancelled; a request that never answers must not stall a job forever.
    timeout(ms) {
      let t;
      const p = new Promise((_, reject) => (t = setTimeout(() => reject(new TypeError(`${ms / 1000} 秒没有回应`)), ms)));
      return { p, cancel: () => clearTimeout(t) };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    random: () => Math.random(),
    cookie: async (name) => (await chrome.cookies.get({ url: "https://www.bilibili.com", name }))?.value || ""
  };
  const cfg = { gapMs: 1000, jitterMs: 500, backoffMs: 90000, strikes: 3, timeoutMs: 30000, emptyRetryMs: 1500 };

  // fetch with cfg.timeoutMs; a timeout aborts the request and throws like a dropped connection.
  async function timedFetch(url, init) {
    const ctl = new AbortController();
    const t = io.timeout(cfg.timeoutMs);
    try {
      return await Promise.race([io.fetch(url, { ...init, signal: ctl.signal }), t.p]);
    } catch (e) {
      ctl.abort();
      throw e;
    } finally {
      t.cancel();
    }
  }

  function biliError(message, code) {
    return Object.assign(new Error(message), code !== undefined ? { code } : {});
  }

  // ---- throttle queue: each caller waits for the previous slot plus the gap ----
  // holdUntil: a risk answer or a dropped connection pauses the whole queue, not just the call that saw it, so other
  // jobs sharing the queue do not keep hitting B站 during the back-off.
  let chain = Promise.resolve();
  let lastAt = -Infinity;
  let holdUntil = 0;
  function slot() {
    const turn = chain.then(async () => {
      const wait = Math.max(lastAt + cfg.gapMs + io.random() * cfg.jitterMs, holdUntil) - io.now();
      if (wait > 0) await io.sleep(wait);
      lastAt = io.now();
    });
    chain = turn.catch(() => {});
    return turn;
  }

  async function readJson(res) {
    try {
      return await res.json();
    } catch {
      throw biliError("B站返回的不是 JSON（可能被风控拦截或需要重新登录）");
    }
  }

  // ~10 minutes in all, enough for Wi-Fi to come back after the laptop wakes.
  const NET_RETRY = [5000, 15000, 30000, 60000, 120000, 300000];
  // Pauses the queue for ms and tells Bili.onHold (jobs.js shows 「被限流，90 秒后重试」 from it).
  function hold(ms, why, n, of) {
    holdUntil = Math.max(holdUntil, io.now() + ms);
    try { Bili.onHold?.({ until: Math.ceil(holdUntil / 1000), why, n, of }); } catch {}
  }
  // GET with risk-control back-off; returns the whole JSON ({ code, message, data }).
  // `url` may be an async function (a WBI-signed request): it is signed again for every try, and a risk answer drops the
  // mixin key first, since a stale key also answers -352 (MoonDigest #19).
  async function getJson(url) {
    let net = 0;
    for (let strike = 1; ; strike++) {
      const u = typeof url === "function" ? await url() : url;
      await slot();
      let res;
      try {
        res = await timedFetch(u, { credentials: "include" });
      } catch (e) {
        // A dropped connection (or the worker being reloaded) is not an answer from B站: wait and retry before giving up.
        if (net < NET_RETRY.length) { hold(NET_RETRY[net], "network", net + 1, NET_RETRY.length); net++; strike--; continue; }
        throw biliError(`网络断了，已暂停：${e.message}`, "NETWORK");
      }
      let json = null;
      if (res.status !== 412) {
        if (!res.ok) throw biliError(`B站请求失败 HTTP ${res.status}`);
        json = await readJson(res);
        if (!RISK_CODES.has(json.code)) return json;
      }
      if (strike >= cfg.strikes) throw biliError("被 B站 限流，已暂停", "THROTTLED");
      if (typeof url === "function") wbiKey = { key: "", at: 0 };
      hold(cfg.backoffMs, "throttled", strike, cfg.strikes - 1);
    }
  }

  async function getData(url) {
    const json = await getJson(url);
    if (json.code !== 0) throw biliError(`B站返回 ${json.code}：${json.message}`, json.code);
    return json.data;
  }

  // POST form with the bili_jct csrf cookie (port of MoonDigest triageBiliPost). Never retried.
  async function post(path, fields) {
    const csrf = await io.cookie("bili_jct");
    if (!csrf) throw biliError("未登录 B站", "NOT_LOGGED_IN");
    await slot();
    const body = new URLSearchParams(Object.entries({ ...fields, csrf }).map(([k, v]) => [k, String(v)])).toString();
    const res = await timedFetch(`${API}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!res.ok) throw biliError(`B站请求失败 HTTP ${res.status}`, res.status === 412 ? "THROTTLED" : undefined);
    const json = await readJson(res);
    if (json.code !== 0) throw biliError(`B站返回 ${json.code}：${json.message}`, RISK_CODES.has(json.code) ? "THROTTLED" : json.code);
    return json.data;
  }

  // ---- WBI signing (port of MoonDigest sites.js) ----
  function md5(str) {
    const bytes = new TextEncoder().encode(String(str));
    const len = bytes.length;
    const blocks = ((len + 8) >> 6) + 1;
    const m = new Uint32Array(blocks * 16);
    for (let i = 0; i < len; i++) m[i >> 2] |= bytes[i] << ((i % 4) * 8);
    m[len >> 2] |= 0x80 << ((len % 4) * 8);
    m[blocks * 16 - 2] = (len * 8) >>> 0;
    m[blocks * 16 - 1] = Math.floor((len * 8) / 4294967296);
    const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const K = [];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let off = 0; off < m.length; off += 16) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        const s = S[(i >> 4) * 4 + (i % 4)];
        F = (F + A + K[i] + m[off + g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    let hex = "";
    for (const w of [a0, b0, c0, d0]) {
      for (let i = 0; i < 4; i++) hex += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
    }
    return hex;
  }

  const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

  function mixinKey(imgUrl, subUrl) {
    const key = (u) => String(u).split("/").pop().split(".")[0];
    const raw = key(imgUrl) + key(subUrl);
    return MIXIN_TAB.map((i) => raw[i]).join("").slice(0, 32);
  }

  function wbiSign(params, key, wts) {
    const all = { ...params, wts };
    const query = Object.keys(all)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ""))}`)
      .join("&");
    return `${query}&w_rid=${md5(query + key)}`;
  }

  // The mixin key comes from nav's wbi_img (present even when logged out, code -101); cached 10 minutes.
  let wbiKey = { key: "", at: 0 };
  async function wbiQuery(params) {
    if (!wbiKey.key || io.now() - wbiKey.at > 10 * 60 * 1000) {
      const img = (await getJson(`${API}/x/web-interface/nav`))?.data?.wbi_img;
      if (!img?.img_url || !img?.sub_url) throw biliError("拿不到 WBI 签名密钥");
      wbiKey = { key: mixinKey(img.img_url, img.sub_url), at: io.now() };
    }
    return wbiSign(params, wbiKey.key, Math.floor(io.now() / 1000));
  }
  // Signed GET -> data. A signature rejection (-403) refetches the mixin key and tries once more.
  async function getWbiData(base, params) {
    const signed = async () => `${base}?${await wbiQuery(params)}`;
    let j = await getJson(signed);
    if (j.code === -403) {
      wbiKey = { key: "", at: 0 };
      j = await getJson(signed);
    }
    if (j.code !== 0) throw biliError(`B站返回 ${j.code}：${j.message}`, j.code);
    return j.data;
  }

  // A success answer with an empty list where one is expected can be risk control (MoonDigest #33): wait 1.5 s and
  // ask once more.
  async function again(fetchOnce, empty) {
    const r = await fetchOnce();
    if (!empty(r)) return r;
    await io.sleep(cfg.emptyRetryMs);
    return fetchOnce();
  }

  // ---- shapes ----
  const num = (v) => Number(v) || 0;
  // Dynamic stats come as text: "2505", "12.5万", "1.2亿".
  function parseCount(v) {
    const s = String(v ?? "");
    const n = parseFloat(s) || 0;
    return Math.round(s.includes("亿") ? n * 1e8 : s.includes("万") ? n * 1e4 : n);
  }
  const person = (x) => ({
    mid: String(x.mid),
    name: x.uname ?? x.name ?? x.nickname ?? "",
    face: x.face ?? x.avatar ?? "",
    sign: String(x.sign || "").slice(0, 60),
    ov: x.official_verify?.desc || x.official?.title || x.official?.desc || ""
  });
  // A dynamic item from feed/all or feed/space; video fields are empty for other types.
  function dynItem(it) {
    const a = it.modules?.module_dynamic?.major?.archive;
    const author = it.modules?.module_author || {};
    return {
      dynId: String(it.id_str),
      type: it.type,
      mid: String(author.mid ?? ""),
      name: author.name || "",
      face: author.face || "",
      at: num(author.pub_ts),
      bvid: a?.bvid || "",
      aid: a ? String(a.aid) : "",
      title: a?.title || "",
      cover: a?.cover || "",
      play: parseCount(a?.stat?.play),
      commentType: num(it.basic?.comment_type),
      commentOid: String(it.basic?.comment_id_str || ""),
      forwards: num(it.modules?.module_stat?.forward?.count),
      comments: num(it.modules?.module_stat?.comment?.count)
    };
  }
  const reply = (r) => ({ rpid: String(r.rpid), mid: String(r.mid), name: r.member?.uname || "", face: r.member?.avatar || "", at: num(r.ctime), rcount: num(r.rcount) });

  const q = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null)).toString();

  // ---- endpoints ----
  const Bili = {
    onHold: null, // ({ until: unix sec, why: "throttled" | "network", n, of }) when the queue pauses
    io, cfg, getJson, getData, post, md5, mixinKey, wbiSign, wbiQuery, parseCount,

    // { isLogin, mid, name, face }; does not throw when logged out.
    async nav() {
      const d = (await getJson(`${API}/x/web-interface/nav`)).data || {};
      return { isLogin: !!d.isLogin, mid: d.mid ? String(d.mid) : "", name: d.uname || "", face: d.face || "" };
    },
    async relationStat(vmid) {
      const d = await getData(`${API}/x/relation/stat?${q({ vmid })}`);
      return { following: num(d.following), follower: num(d.follower) };
    },
    // [{ mid, name, face, sign, ov }] for up to 50 uids.
    async userCards(uids) {
      const d = await getData(`${VC}/account/v1/user/cards?${q({ uids: uids.join(",") })}`);
      return (d || []).map(person);
    },
    // One page: { code, total, list: [person] }. code 22115 = hidden list; other codes come back too.
    async followings(vmid, pn) {
      const url = `${API}/x/relation/followings?${q({ vmid, pn, ps: 50, order: "desc" })}`;
      const j = await again(() => getJson(url), (j) => pn === 1 && j.code === 0 && !j.data?.list?.length);
      if (j.code !== 0) return { code: j.code, message: j.message, total: 0, list: [] };
      // special: in 特别关注 (group -10); groups: the account's own groups (tagid ≥ 0), needed to take it out of -10.
      const item = (x) => ({ ...person(x), mtime: num(x.mtime), special: x.special === 1 || (x.tag || []).includes(-10), groups: (x.tag || []).filter((t) => t >= 0) });
      return { code: 0, total: num(j.data?.total), list: (j.data?.list || []).map(item) };
    },
    // One page of the account's followings that I follow too (not capped at 100 like followings): { code, total, list: [person] }.
    // Hidden lists answer 22115 here too; any code comes back as data.
    async sameFollowings(vmid, pn) {
      const j = await getJson(`${API}/x/relation/same/followings?${q({ vmid, pn, ps: 50 })}`);
      if (j.code !== 0) return { code: j.code, message: j.message, total: 0, list: [] };
      return { code: 0, total: num(j.data?.total), list: (j.data?.list || []).map(person) };
    },
    // One page of fans:{ total, list: [person + mtime + mutual] }; attribute 6 = 互关.
    async followers(vmid, pn) {
      const url = `${API}/x/relation/followers?${q({ vmid, pn, ps: 50 })}`;
      const d = await again(() => getData(url), (d) => pn === 1 && !d?.list?.length);
      return { total: num(d?.total), list: (d?.list || []).map((x) => ({ ...person(x), mtime: num(x.mtime), mutual: x.attribute === 6 })) };
    },
    // Latest 30 videos + 分区 counts: { code, count, tlist: {分区: n}, v: [{ t, tid, c, p, len }] }.
    async arcSearch(mid) {
      const params = { mid, ps: 30, pn: 1, order: "pubdate", platform: "web", web_location: 1550101 };
      const d = await again(() => getWbiData(`${API}/x/space/wbi/arc/search`, params), (d) => num(d?.page?.count) > 0 && !d?.list?.vlist?.length);
      const tl = d?.list?.tlist || {};
      return {
        code: 0,
        count: num(d?.page?.count),
        tlist: Object.fromEntries(Object.values(tl).map((t) => [t.name, t.count])),
        v: (d?.list?.vlist || []).map((x) => ({ t: x.title, tid: x.typeid, c: x.created, p: x.play, len: x.length }))
      };
    },
    // Video feed of my followings: { items: [dynItem], offset, hasMore }.
    async feedVideo(offset = "") {
      const url = `${API}/x/polymer/web-dynamic/v1/feed/all?${q({ type: "video", offset })}`;
      const d = await again(() => getData(url), (d) => !offset && !d?.items?.length);
      return { items: (d?.items || []).map(dynItem), offset: d?.offset || "", hasMore: !!d?.has_more, baseline: d?.update_baseline || "" };
    },
    // Cheap new-video check: { updateNum }.
    async feedUpdate(baseline) {
      const d = await getData(`${API}/x/polymer/web-dynamic/v1/feed/all/update?${q({ type: "video", update_baseline: baseline })}`);
      return { updateNum: num(d?.update_num) };
    },
    // One page of someone's dynamics: { items: [dynItem], offset, hasMore }.
    async spaceDynamics(hostMid, offset = "") {
      const d = await getData(`${API}/x/polymer/web-dynamic/v1/feed/space?${q({ host_mid: hostMid, offset })}`);
      return { items: (d?.items || []).map(dynItem), offset: d?.offset || "", hasMore: !!d?.has_more };
    },
    // One page of reposts of a dynamic: { items: [{ dynId, mid, name, face }], offset, hasMore, total }. No times here.
    async forwards(dynId, offset = "") {
      const d = await getData(`${API}/x/polymer/web-dynamic/v1/detail/forward?${q({ id: dynId, offset })}`);
      return {
        items: (d?.items || []).map((it) => ({ dynId: String(it.id_str), ...person(it.user || {}) })),
        offset: d?.offset || "",
        hasMore: !!d?.has_more,
        total: num(d?.total)
      };
    },
    async dynDetail(dynId) {
      return dynItem((await getData(`${API}/x/polymer/web-dynamic/v1/detail?${q({ id: dynId })}`))?.item || {});
    },
    // One page of top-level comments: { list: [reply], count }.
    async replies(type, oid, pn) {
      const d = await getData(`${API}/x/v2/reply?${q({ type, oid, pn, ps: 20, sort: 0 })}`);
      return { list: (d?.replies || []).map(reply), count: num(d?.page?.count) };
    },
    async subReplies(type, oid, root, pn) {
      const d = await getData(`${API}/x/v2/reply/reply?${q({ type, oid, root, pn, ps: 20 })}`);
      return { list: (d?.replies || []).map(reply), count: num(d?.page?.count) };
    },
    // One page of reply/like/at notifications, newest first: { items: [{ id, users: [person], at }], cursor: { id, time } | null }.
    // A like item is one liked thing; a new like moves it back to the top with a newer at and more users.
    async msgfeed(kind, cursor) {
      const timeKey = `${kind}_time`;
      const d = await getData(`${API}/x/msgfeed/${kind}?${q({ id: cursor?.id, [timeKey]: cursor?.time, platform: "web", build: 0, mobi_app: "web" })}`);
      const box = kind === "like" ? d?.total : d;
      const c = box?.cursor;
      return {
        items: (box?.items || []).map((it) => ({ id: String(it.id ?? ""), users: (kind === "like" ? it.users || [] : [it.user]).filter(Boolean).map(person), at: num(it[timeKey]) })),
        cursor: c && !c.is_end ? { id: c.id, time: c.time } : null
      };
    },
    async unread() {
      return getData(`${API}/x/msgfeed/unread?build=0&mobi_app=web`);
    },
    // One page of PM sessions: { list: [{ talker, ts }], hasMore }; ts is microseconds, pass the last one as endTs.
    async sessions(endTs) {
      const d = await getData(`${VC}/session_svr/v1/session_svr/get_sessions?${q({ session_type: 1, group_fold: 1, unfollow_fold: 0, sort_rule: 2, end_ts: endTs, build: 0, mobi_app: "web" })}`);
      // system_msg_type > 0 = a B站 service account (创作助手 etc., talker ids like 8444249301319xx), not a person.
      return { list: (d?.session_list || []).map((s) => ({ talker: String(s.talker_id), ts: num(s.session_ts), system: num(s.system_msg_type) > 0 })), hasMore: !!d?.has_more };
    },
    // One page of messages, newest first, without their text: { list: [{ seq, at, sender }], hasMore, minSeq }.
    async sessionMsgs(talker, endSeq) {
      const d = await getData(`${VC}/svr_sync/v1/svr_sync/fetch_session_msgs?${q({ talker_id: talker, session_type: 1, size: 50, end_seqno: endSeq, build: 0, mobi_app: "web" })}`);
      return {
        list: (d?.messages || []).map((m) => ({ seq: num(m.msg_seqno), at: num(m.timestamp), sender: String(m.sender_uid) })),
        hasMore: !!d?.has_more,
        minSeq: num(d?.min_seqno)
      };
    },
    // Following groups (tagid -10 = 特别关注, 0 = 默认分组). copyUsers adds fids to tagids and keeps their other groups;
    // moveUsers takes them out of beforeTagids into afterTagids. Both leave the follow itself alone.
    async copyUsers(fids, tagids) {
      return post("/x/relation/tags/copyUsers", { fids: [].concat(fids).join(","), tagids: [].concat(tagids).join(",") });
    },
    async moveUsers(fids, beforeTagids, afterTagids) {
      return post("/x/relation/tags/moveUsers", { fids: [].concat(fids).join(","), beforeTagids: [].concat(beforeTagids).join(","), afterTagids: [].concat(afterTagids).join(",") });
    },
    // act 1 follow, 2 unfollow.
    async modifyRelation(mid, act) {
      if (act !== 1 && act !== 2) throw biliError("act 只能是 1 或 2");
      return post("/x/relation/modify", { fid: mid, act, re_src: 11 });
    }
  };

  globalThis.Bili = Bili;
})();
