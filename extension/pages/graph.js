// #graph 关系图, laid out as an atlas: the map fills the page, each 圈子 is a soft tinted territory with its name printed
// on it, controls sit in the corners, and the 圈子 / 可能想关注 list and a person's detail open as side panels the map
// moves aside for. Data from BSGraph.compute (lib/graph.js); 2D canvas + d3-force (vendor/d3.min.js); 3D via
// vendor/3d-force-graph.min.js, loaded only when the user picks 3D.
(() => {
  const PALETTE = ["#e8590c", "#1c7ed6", "#2f9e44", "#ae3ec9", "#7048e8", "#0c8599", "#d6336c", "#5c940d",
    "#4263eb", "#c2255c", "#087f5b", "#9c36b5", "#20c997", "#1971c2", "#66a80f", "#a61e4d"];
  const color = (g) => (g < 0 ? "#9a9aa2" : PALETTE[g % PALETTE.length]);
  const KEYS = ["bs_me", "bs_people", "bs_followings", "bs_circle", "bs_content", "bs_settings", "bs_unfollowed", "bs_jobs", "bs_group_names"];
  const EGO = 40;
  const AI_NAME = `<span class="ai-spark"></span>AI 起名`; // ✦ on every button that calls AI
  const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  BS.page("graph", { mount, unmount: () => cleanup?.() });
  let cleanup = null;
  let T = null; // three.js classes borrowed from the 3D bundle's own node mesh (it does not export THREE)

  function mount(view) {
    const { esc } = BS;
    const offs = [];
    let alive = true; // async work (storage reads, timers, the 3D script) must not touch #view once another page owns it
    cleanup = () => { alive = false; clearTimeout(pending); offs.forEach((f) => f()); cleanup = null; };
    let st = null, res = null, recs = [];
    let alpha = 0.5;

    async function load() {
      // Only the small keys while waiting: this re-runs on every bs_jobs tick during a sync.
      st = await BS.get(["bs_jobs", "bs_followings"]);
      if (!alive) return;
      // The map needs both crawls complete once; a half-crawled map would put people in the wrong places.
      const jobs = st.bs_jobs || {};
      if (!st.bs_followings?.list?.length || !BSGraph.jobReady(jobs.circle) || !BSGraph.jobReady(jobs.content)) return empty(jobs);
      st = await BS.get(KEYS);
      if (!alive) return;
      alpha = st.bs_settings?.alpha ?? 0.5;
      ui();
    }

    // Checklist of what the map waits for: done / running with progress / a start button.
    function empty(jobs) {
      const NEED = [
        ["mine", "我的关注和粉丝", "你关注了谁", !!st.bs_followings?.list?.length],
        ["circle", "关注的关注", "你关注的人又关注了谁", BSGraph.jobReady(jobs.circle)],
        ["content", "投稿内容", "每个人最近投了什么", BSGraph.jobReady(jobs.content)]
      ];
      const row = ([job, label, what, done]) => {
        const j = jobs[job] || {};
        const waits = j.after && jobs[j.after]?.running; // jobs.js queues 关注的关注 behind 投稿内容 and starts it after
        const held = j.running && j.hold?.until * 1000 > Date.now();
        const state = done ? "✓ 已完成"
          : held ? (j.hold.why === "network" ? "网络断了，稍后自动重试" : "被 B站 限流，稍后自动重试")
          : j.running ? `正在同步${j.total ? ` ${j.done}/${j.total}` : ""}`
          : j.throttled ? "被 B站 限流，已暂停"
          : j.error ? `出错停了：${esc(BS.errText(j.error))}`
          : waits ? "排队中，等投稿内容跑完自动开始"
          : j.done || j.cursor ? "已暂停" : "还没开始";
        const btn = done || j.running || waits ? "" : `<button type="button" data-job="${job}">${j.done || j.cursor ? "继续" : "开始"}</button>`;
        return `<li><b>${esc(label)}</b><span class="muted">（${esc(what)}）</span> · ${state} ${btn}</li>`;
      };
      view.innerHTML = `<div class="gp-empty"><h2>关系图要等这几项同步完</h2>
        <ul class="gp-need">${NEED.map(row).join("")}</ul>
        <p class="muted">跑完这里会自动出图。也可以在右上角「同步」里看进度。</p></div>`;
      view.querySelectorAll("button[data-job]").forEach((b) => (b.onclick = async () => {
        b.disabled = true;
        try { await BS.send("bs-job-start", { job: b.dataset.job }); } catch (err) { BS.toast(err, { error: true }); b.disabled = false; }
      }));
    }

    let pending = 0;
    // Throttle, not debounce: several running jobs write bs_jobs more often than once a second, which would starve a debounce.
    const recheck = () => { if (!res && !pending) pending = setTimeout(() => { pending = 0; load(); }, 800); };
    BS.onStore("bs_jobs", recheck);
    BS.onStore(["bs_followings", "bs_circle", "bs_content"], () => {
      if (!res) return recheck();
      const bar = view.querySelector(".gp-stale");
      if (bar) bar.hidden = false;
    });
    BS.onStore("bs_group_names", async () => {
      if (!res) return;
      st.bs_group_names = await BS.get("bs_group_names");
      renderSide(); showDetail(selected); draw(); if (fg) labels3D();
    });
    // Save names for groups (by "ai" or "me"); an entry matched by overlap moves to the group's current key.
    async function saveNames(rows) {
      const store = { ...((await BS.get("bs_group_names")) || {}) };
      for (const [g, v] of rows) {
        const old = BSGraph.groupName(g, store);
        for (const [k, e] of Object.entries(store)) if (e === old) delete store[k];
        if (v) store[g.key] = { ...v, mids: g.mids, at: Math.floor(Date.now() / 1000) };
      }
      await chrome.storage.local.set({ bs_group_names: store });
    }
    async function aiName(btn) {
      if (!st.bs_settings?.ai?.baseUrl) {
        if (await BS.confirm("还没设置 AI。去「设置」填好 AI 接口，再回来起名。", { ok: "去设置" })) location.hash = "#settings";
        return;
      }
      const todo = groups.filter((g) => gname(g)?.by !== "me"); // names you gave by hand stay
      if (!todo.length) return BS.toast("每个圈子都是你自己起的名字");
      const titles = (mid) => (st.bs_content?.[mid]?.v || []).slice(0, 3).map((v) => v.t);
      const byMid = new Map(nodes.map((n) => [n.mid, n]));
      const payload = todo.map((g) => ({ key: g.key, zones: g.zones,
        members: g.mids.map((m) => byMid.get(m)).map((n) => ({ name: n.name, sign: n.sign, titles: titles(n.mid) })) }));
      btn.disabled = true; btn.setAttribute("aria-busy", "true"); btn.textContent = "正在起名…";
      try {
        const { names } = await BS.send("bs-ai-name-groups", { groups: payload });
        const by = new Map(names.map((x) => [x.key, x]));
        await saveNames(todo.filter((g) => by.has(g.key)).map((g) => [g, { name: by.get(g.key).name, desc: by.get(g.key).desc, by: "ai" }]));
        BS.toast(`起好了 ${by.size} 个圈子的名字`);
      } catch (err) {
        BS.toast(err, { error: true });
      } finally {
        if (btn.isConnected) { btn.disabled = false; btn.removeAttribute("aria-busy"); btn.innerHTML = AI_NAME; }
      }
    }
    async function rename(g) {
      const cur = gname(g);
      const v = prompt(`给这个圈子起名（2–6 个字，留空恢复成「${g.lead}」）`, cur?.name || "");
      if (v === null) return;
      const name = v.trim().slice(0, 6);
      await saveNames([[g, name ? { name, desc: name === cur?.name ? cur.desc || "" : "", by: "me" } : null]]);
    }

    BS.onStore("bs_unfollowed", async () => {
      if (!res) return;
      st.bs_unfollowed = await BS.get("bs_unfollowed");
      renderRecs();
    });

    // ---------------- the page ----------------
    let nodes = [], links = [], groups = [], stats = {}, cent = [];
    let mode = "map"; // map | ego
    let egoCenter = null, vnodes = [], vlinks = [], egoBy = new Map();
    let W = 0, H = 0, transform = null, zoom = null, fitted = false, laidOut = false, kFit = 1;
    let hover = null, selected = null, activeGroup = null, hoverGroup = null, query = "", tab = "groups";
    let intro = 1; // 0 → 1 the first time the map appears: territories first, then their names
    let fg = null; // 3D graph instance
    let el = {};

    // 圈子 names: the AI / hand-given name (bs_group_names) if any, else 「<its best-known member you follow>等」.
    const gname = (g) => BSGraph.groupName(g, st.bs_group_names);
    const short = (g) => gname(g)?.name || `${g.lead}等`;
    const glabel = (g) => `${g.zones.length ? g.zones.join("·") + "｜" : ""}${g.top.join("、")}`;

    function ui() {
      view.innerHTML = `<div class="gp"><main class="gp-stage">
          <canvas></canvas>
          <div class="gp-tip" hidden></div>
          <div class="gp-fl gp-tl">
            <input class="gp-search" type="search" placeholder="搜 UP 主名字，回车跳过去" autocomplete="off">
            <div class="gp-bar" hidden><button type="button">← 返回全图</button><span></span></div>
            <div class="gp-chips"><button type="button" data-open="groups" aria-pressed="false">圈子 <small data-n="groups"></small></button><button type="button" data-open="recs" aria-pressed="false">可能想关注 <small data-n="recs"></small></button></div>
          </div>
          <div class="gp-fl gp-tr">
            <span class="gp-stale" hidden>数据变了 <button type="button" class="link">重新计算</button></span>
            <span class="gp-seg"><button type="button" data-dim="2" aria-pressed="true">平面</button><button type="button" data-dim="3" aria-pressed="false">立体</button></span>
            <details class="gp-show"><summary>显示</summary><div class="gp-menu">
              <label><input type="checkbox" data-opt="l2" checked> 没关注的人</label>
              <label><input type="checkbox" data-opt="labels" checked> 人名</label>
              <label><input type="checkbox" data-opt="iso"> 没有关系的（<span class="gp-isoN"></span>）</label></div></details>
          </div>
          <div class="gp-fl gp-bl"><label class="gp-alpha" title="远近按什么算：左边只看关注关系，右边只看投稿内容"><span>关注关系</span><input type="range" min="0" max="1" step="0.05" aria-label="远近按关注关系还是投稿内容算"><span>投稿内容</span></label></div>
          <div class="gp-fl gp-br"><span><i class="dot"></i>你关注的</span><span title="你还没关注，但你关注的人里至少 5 人关注 TA"><i class="ring"></i>你没关注</span><span class="gp-size" title="你关注的人里关注 TA 的越多，圆越大">圆越大，关注 TA 的越多</span></div>
          <section class="gp-panel gp-list" aria-label="圈子和可能想关注">
            <div class="gp-tabs" role="tablist">
              <button type="button" role="tab" data-tab="groups" aria-selected="true">圈子</button>
              <button type="button" role="tab" data-tab="recs" aria-selected="false">可能想关注</button>
              <button type="button" class="link gp-x" data-close="list" aria-label="收起">✕</button>
            </div>
            <div class="gp-scroll"></div>
          </section>
          <aside class="gp-panel gp-detail" aria-label="详情"></aside>
          <div class="gp-loading">正在计算关系…</div>
        </main></div>`;
      const q = (s) => view.querySelector(s);
      el = { search: q(".gp-search"), isoN: q(".gp-isoN"), alpha: q(".gp-alpha input"), scroll: q(".gp-scroll"), list: q(".gp-list"),
        detail: q(".gp-detail"), stage: q(".gp-stage"), cv: q(".gp-stage canvas"), tip: q(".gp-tip"), bar: q(".gp-bar"),
        loading: q(".gp-loading"), fl: [...view.querySelectorAll(".gp-fl")], opt: (k) => q(`[data-opt="${k}"]`) };
      el.alpha.value = String(1 - alpha);
      wire();
      setTimeout(run, 30); // let the loading state paint first
    }

    function run() {
      if (!alive) return;
      const t0 = performance.now();
      res = BSGraph.compute(st, { alpha });
      ({ nodes, groups, stats } = res);
      // Never the bare mid as a name: 「未获取名字」 (mid in small text in the detail) and the 已注销 marker.
      for (const n of nodes) n.name = BS.nameOf(st.bs_people?.[n.mid], n.mid).name;
      // Circle label = its best-known followed member with a real name (an account whose name never loaded or that
      // closed would label the circle 「未获取名字等」).
      const realName = (n) => n.name && n.name !== String(n.mid) && n.name !== "未获取名字" && !st.bs_people?.[n.mid]?.gone;
      for (const g of groups) g.lead = nodes.filter((n) => n.g === g.id && !n.l2 && realName(n)).sort((a, b) => b.deg - a.deg)[0]?.name || g.top.find((t) => t && t !== "未获取名字") || g.top[0];
      recs = BSGraph.recommend(res, recOpts());
      console.debug(`[graph] compute ${Math.round(performance.now() - t0)} ms`);
      el.loading.textContent = "正在布局…";
      setTimeout(() => {
        if (!alive) return;
        const first = !laidOut;
        layoutMap();
        el.loading.hidden = true;
        el.isoN.textContent = nodes.filter((n) => n.iso).length;
        view.querySelector('[data-n="groups"]').textContent = groups.length;
        view.querySelector('[data-n="recs"]').textContent = Math.min(100, recs.length);
        renderSide();
        if (selected) selected = nodes.find((n) => n.mid === selected.mid) || null;
        showDetail(selected);
        if (first) playIntro();
        if (fg) build3D();
      }, 20);
    }
    const recOpts = () => ({ slowDays: st.bs_settings?.slowDays ?? 90, deadDays: st.bs_settings?.deadDays ?? 365, unfollowed: st.bs_unfollowed || {}, groupLabel: (g) => gname(g)?.name });

    // First appearance only: territories fade in, their names follow (≈600 ms).
    function playIntro() {
      if (calm()) return;
      const t0 = performance.now();
      intro = 0;
      requestAnimationFrame(function step(t) {
        if (!alive) return;
        intro = Math.max(0, Math.min(1, (t - t0) / 600)); // a frame's timestamp can be a little before t0
        draw();
        if (intro < 1) requestAnimationFrame(step);
      });
    }

    // ---------------- 2D map layout ----------------
    function layoutMap() {
      nodes.forEach((n, i) => { n.i = i; n.r = 2.5 + Math.sqrt(n.deg) * 1.6; n.followers = []; });
      nodes.forEach((n) => n.outIn.forEach((j) => nodes[j].followers.push(n.i)));
      const maxS = d3.max(res.edges, (e) => e[2]) || 1;
      links = res.edges.map(([a, b, s]) => ({ source: a, target: b, s }));
      const linked = new Set(res.edges.flatMap(([a, b]) => [a, b]));
      nodes.forEach((n) => { n.iso = !linked.has(n.i) && !n.followers.length && !n.outIn.length; });
      // Each 圈子 gets a spot on a golden-angle spiral (biggest in the middle); members pull toward it
      const anchors = groups.map((g, k) => { const r = 95 * Math.sqrt(k + 0.5), t = k * 2.39996; return [r * Math.cos(t), r * Math.sin(t)]; });
      const anchor = (n) => (n.g >= 0 ? anchors[n.g] : [0, 0]);
      d3.forceSimulation(nodes)
        .force("link", d3.forceLink(links)
          .distance((l) => (sameG(l) ? 14 : 70) + 50 * (1 - l.s / maxS))
          .strength((l) => (sameG(l) ? 0.7 : 0.04) * (0.3 + 0.7 * l.s / maxS)))
        .force("charge", d3.forceManyBody().strength(-30).distanceMax(500))
        .force("collide", d3.forceCollide((n) => n.r + 1.5))
        .force("x", d3.forceX((n) => anchor(n)[0]).strength((n) => (n.g >= 0 ? 0.12 : 0.02)))
        .force("y", d3.forceY((n) => anchor(n)[1]).strength((n) => (n.g >= 0 ? 0.12 : 0.02)))
        .stop()
        .tick(500);
      // Where each 圈子's name goes: the middle of its people.
      cent = groups.map((g) => {
        const m = nodes.filter((n) => n.g === g.id);
        return { g, x: d3.mean(m, (n) => n.x), y: d3.mean(m, (n) => n.y) };
      });
      mode = "map"; vnodes = nodes; vlinks = links; egoCenter = null; el.bar.hidden = true;
      laidOut = true; fitted = false;
      resize();
    }
    const gOf = (x) => (typeof x === "object" ? x.g : nodes[x].g);
    const sameG = (l) => { const a = gOf(l.source), b = gOf(l.target); return a >= 0 && a === b; };

    // ---------------- ego view (Connected Papers style) ----------------
    function enterEgo(n) {
      if (fg) setDim(2);
      const members = [n.i, ...n.near.slice(0, EGO).map(([j]) => j)];
      vnodes = members.map((j) => ({ ...nodes[j], x: undefined, y: undefined, vx: undefined, vy: undefined }));
      egoBy = new Map(vnodes.map((v) => [v.i, v]));
      const c = vnodes[0];
      c.fx = 0; c.fy = 0;
      const sim = res.sim;
      const maxS = d3.max(vnodes.slice(1), (v) => sim(c.i, v.i)) || 1;
      vlinks = vnodes.slice(1).map((v) => ({ source: c, target: v, s: sim(c.i, v.i), hub: true }));
      for (const a of vnodes.slice(1)) {
        const best = vnodes.slice(1).filter((b) => b !== a).map((b) => [b, sim(a.i, b.i)]).sort((x, y) => y[1] - x[1]).slice(0, 2);
        for (const [b, s] of best) if (s > 0.03 && a.i < b.i) vlinks.push({ source: a, target: b, s });
      }
      d3.forceSimulation(vnodes)
        .force("link", d3.forceLink(vlinks)
          .distance((l) => (l.hub ? 40 + 260 * (1 - l.s / maxS) : 60))
          .strength((l) => (l.hub ? 0.9 : 0.15)))
        .force("charge", d3.forceManyBody().strength(-120))
        .force("collide", d3.forceCollide((v) => v.r + 8))
        .stop()
        .tick(300);
      mode = "ego"; egoCenter = c; hover = null; selected = nodes[n.i]; el.tip.hidden = true;
      showDetail(selected);
      el.bar.hidden = false;
      el.bar.querySelector("span").textContent = `最像 ${n.name} 的 ${vnodes.length - 1} 人，越近越像`;
      fitted = false; fit(); draw();
    }
    function leaveEgo() {
      const keep = selected;
      vnodes = nodes; vlinks = links; mode = "map"; egoCenter = null; el.bar.hidden = true;
      fitted = false; fit();
      if (keep) focusNode(keep);
    }

    // ---------------- 2D drawing ----------------
    const css = (v) => getComputedStyle(el.stage).getPropertyValue(v).trim();
    const dark = () => css("--map-dark") === "1";
    const pos = (j) => (mode === "map" ? nodes[j] : egoBy.get(j));
    const visible = (n) => (mode === "ego" ? n === egoCenter || el.opt("l2").checked || !n.l2 : (el.opt("l2").checked || !n.l2) && (el.opt("iso").checked || !n.iso));
    const isOpen = (p) => p.classList.contains("open");

    function resize() {
      const r = el.cv.getBoundingClientRect(), dpr = devicePixelRatio || 1;
      W = r.width; H = r.height;
      el.cv.width = W * dpr; el.cv.height = H * dpr;
      el.cv.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
      if (laidOut && !fitted && W && H) fit(); // the stage can have no size at mount; fit on the first real size
      draw();
      if (fg) fg.width(W).height(H);
    }
    // The part of the stage the floating controls and open panels leave free. A side panel takes its side; a panel wider
    // than 60% of the stage (the bottom sheets on a narrow window) takes the bottom.
    function room() {
      const p = { l: 16, r: 16, t: 16, b: 16 };
      for (const x of el.fl) {
        if (x.offsetTop < H / 2) p.t = Math.max(p.t, x.offsetTop + x.offsetHeight + 8);
        else p.b = Math.max(p.b, H - x.offsetTop + 8);
      }
      for (const x of [el.list, el.detail]) {
        if (!isOpen(x)) continue;
        if (x.offsetWidth > W * 0.6) p.b = Math.max(p.b, H - x.offsetTop + 8);
        else if (x.offsetLeft < W / 2) p.l = Math.max(p.l, x.offsetLeft + x.offsetWidth + 8);
        else p.r = Math.max(p.r, W - x.offsetLeft + 8);
      }
      return p;
    }
    // Fit what is shown (all, or one 圈子) into the free room; animated when the room changed under an open map.
    function fit(animate = false, only = null) {
      if (!W || !H) return;
      const vis = vnodes.filter((n) => visible(n) && (only === null || n.g === only));
      if (!vis.length) return;
      const [x0, x1] = d3.extent(vis, (n) => n.x), [y0, y1] = d3.extent(vis, (n) => n.y);
      const p = room(), w = Math.max(80, W - p.l - p.r), h = Math.max(80, H - p.t - p.b);
      const k = Math.min(only === null ? 4 : 2.5, 0.94 * Math.min(w / (x1 - x0 || 1), h / (y1 - y0 || 1)));
      if (only === null && mode === "map") kFit = k;
      fitted = true;
      const t = d3.zoomIdentity.translate((p.l - p.r) / 2, (p.t - p.b) / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
      const sel = d3.select(el.cv);
      if (animate && !calm()) sel.transition().duration(400).call(zoom.transform, t); else sel.call(zoom.transform, t);
    }
    // A panel just opened: keep the person in focus where it is unless the panel would cover it, then slide the map just
    // enough; with nobody in focus, refit the overview (or slide a zoomed-in map by half the panel).
    function makeRoom() {
      if (fg || !laidOut) return;
      const f = selected && pos(selected.i);
      if (!f) {
        if (transform.k <= kFit * 1.05 || narrow()) return fit(true, activeGroup);
        const dx = isOpen(el.list) ? (el.list.offsetWidth + 16) / 2 : 0;
        return d3.select(el.cv).transition().duration(calm() ? 0 : 350).call(zoom.translateBy, dx / transform.k, 0);
      }
      const p = room(), [sx, sy] = toScreen(f.x, f.y);
      const dx = sx < p.l + 40 ? p.l + 40 - sx : sx > W - p.r - 40 ? W - p.r - 40 - sx : 0;
      const dy = sy > H - p.b - 40 ? H - p.b - 40 - sy : 0;
      if (dx || dy) d3.select(el.cv).transition().duration(calm() ? 0 : 350).call(zoom.translateBy, dx / transform.k, dy / transform.k);
    }
    function focusSet() {
      const f = selected ?? hover;
      if (!f) return null;
      return new Set([f.i, ...f.outIn, ...f.followers, ...f.near.slice(0, 8).map(([j]) => j)]);
    }
    function dimmed(n, fs) {
      if (fs) return !fs.has(n.i);
      const g = hoverGroup ?? activeGroup;
      if (g !== null) return n.g !== g;
      if (query) return !n.name.toLowerCase().includes(query);
      return false;
    }
    const toScreen = (x, y) => [transform.x + W / 2 + x * transform.k, transform.y + H / 2 + y * transform.k];
    const ease = (t) => 1 - (1 - t) ** 3;

    // Territory tint: the 圈子 color, pulled toward white in dark mode (a dark hue over a dark ground turns muddy), fading
    // as you zoom in so the people take over from the regions.
    function tint(hex) {
      if (!dark()) return hex;
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return `rgb(${r + (255 - r) * 0.45 | 0},${g + (255 - g) * 0.45 | 0},${b + (255 - b) * 0.45 | 0})`;
    }
    // Territory names: the 圈子 color pulled toward the text color, so it reads as text on its own tint.
    function ink(hex) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      const t = dark() ? [236, 237, 240] : [24, 25, 28], m = dark() ? 0.55 : 0.45;
      return `rgb(${r * (1 - m) + t[0] * m | 0},${g * (1 - m) + t[1] * m | 0},${b * (1 - m) + t[2] * m | 0})`;
    }

    let terr = null; // offscreen canvas the territories are painted on before they go on the map at low opacity
    function draw() {
      if (!W || !laidOut || fg) return;
      const ctx = el.cv.getContext("2d");
      const k = transform.k;
      const fs = mode === "map" ? focusSet() : null;
      const ga = hoverGroup ?? activeGroup;
      const show = ease(intro), late = ease(Math.max(0, (intro - 0.35) / 0.65));
      ctx.clearRect(0, 0, W, H);

      if (mode === "map") {
        const dpr = devicePixelRatio || 1;
        terr ??= document.createElement("canvas");
        if (terr.width !== el.cv.width || terr.height !== el.cv.height) { terr.width = el.cv.width; terr.height = el.cv.height; }
        const t = terr.getContext("2d");
        const base = (dark() ? 0.13 : 0.11) * Math.max(0.35, Math.min(1, (1.6 * kFit) / k)) * (fs ? 0.6 : 1) * show;
        // One pass per opacity: with a 圈子 lit, the others stay as faint ground and the lit one comes forward.
        const paint = (keep, a) => {
          t.setTransform(1, 0, 0, 1, 0, 0); t.clearRect(0, 0, terr.width, terr.height);
          t.setTransform(dpr * k, 0, 0, dpr * k, dpr * (transform.x + W / 2), dpr * (transform.y + H / 2));
          for (const n of vnodes) {
            if (n.g < 0 || !visible(n) || !keep(n)) continue;
            t.fillStyle = tint(color(n.g));
            t.beginPath(); t.arc(n.x, n.y, n.r + 16, 0, Math.PI * 2); t.fill();
          }
          ctx.globalAlpha = a; ctx.drawImage(terr, 0, 0, W, H);
        };
        if (ga === null) paint(() => true, base);
        else { paint((n) => n.g !== ga, base * 0.35); paint((n) => n.g === ga, base * 1.4); }
        ctx.globalAlpha = 1;
      }

      ctx.save();
      ctx.translate(transform.x + W / 2, transform.y + H / 2);
      ctx.scale(k, k);
      // Lines only inside the ego view and from the person you point at; the territories carry the clusters.
      if (mode === "ego") {
        ctx.lineWidth = 1 / k; ctx.strokeStyle = css("--edge"); ctx.beginPath();
        for (const l of vlinks) {
          if (!visible(l.source) || !visible(l.target)) continue;
          ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y);
        }
        ctx.stroke();
      }
      const f = selected ?? hover;
      if (f && pos(f.i)) {
        const c = pos(f.i);
        ctx.lineWidth = 1 / k; ctx.strokeStyle = css("--edge-hi");
        ctx.beginPath();
        const to = mode === "map" ? new Set([...f.outIn, ...f.followers]) : new Set(vlinks.filter((l) => l.source.i === f.i || l.target.i === f.i).map((l) => (l.source.i === f.i ? l.target.i : l.source.i)));
        for (const j of to) {
          const n = pos(j); if (!n || !visible(n)) continue;
          ctx.moveTo(c.x, c.y); ctx.lineTo(n.x, n.y);
        }
        ctx.stroke();
      }
      const text = css("--text"), sel = css("--action"), here = css("--accent");
      for (const n of vnodes) {
        if (!visible(n)) continue;
        const dim = mode === "map" && dimmed(n, fs);
        ctx.globalAlpha = (dim ? 0.12 : 0.92) * show;
        const r = n === egoCenter ? Math.min(n.r + 4, 15 / k) : n.r * (mode === "map" ? 0.85 : 1); // the ego center stays ~15 px
        if (n.l2) {
          // 你还没关注: hollow ring in the cluster's color (followed = filled); the user picked this over target/ghost/gray
          ctx.beginPath(); ctx.arc(n.x, n.y, Math.max(1, r - 0.6), 0, Math.PI * 2);
          ctx.lineWidth = Math.max(1.1, r * 0.22); ctx.strokeStyle = color(n.g); ctx.stroke();
        } else {
          ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fillStyle = color(n.g); ctx.fill();
        }
        // pink = where you are (the ego center), blue = the one you picked, ink = under the pointer
        const ring = n === egoCenter ? here : n.i === selected?.i ? sel : n.i === hover?.i ? text : null;
        if (ring) {
          ctx.globalAlpha = 1;
          ctx.beginPath(); ctx.arc(n.x, n.y, r + 3 / k, 0, Math.PI * 2);
          ctx.lineWidth = 2.5 / k; ctx.strokeStyle = ring; ctx.stroke();
        }
      }
      ctx.restore();
      ctx.globalAlpha = 1;

      // Names, in screen space so they stay one size at any zoom. A name that would sit on one already drawn tries a
      // little lower or higher, else waits until you zoom in.
      const bg = css("--bg"), font = css("--font-sans");
      // The corners and open panels count as taken, so no name hides under a control or runs off the edge.
      const taken = [...el.fl, el.list, el.detail].filter((x) => x.classList.contains("gp-fl") || isOpen(x))
        .map((x) => [x.offsetLeft - 4, x.offsetTop - 4, x.offsetLeft + x.offsetWidth + 4, x.offsetTop + x.offsetHeight + 4]);
      const place = (x, y, w, h, shift) => {
        for (const dy of shift ? [0, h, -h, 2 * h] : [0]) {
          const r = [x - w / 2, y + dy - h, x + w / 2, y + dy];
          if (r[0] < 2 || r[2] > W - 2 || r[1] < 2 || r[3] > H - 2) continue;
          if (!taken.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) { taken.push(r); return dy; }
        }
        return null;
      };
      ctx.save();
      ctx.lineJoin = "round"; ctx.textAlign = "center";
      // 圈子 names, biggest first (groups come sorted by size). With a person in focus their people's names go first and
      // the 圈子 names stay as faint ground where there is room.
      const groupNames = (faint) => {
        ctx.globalAlpha = late * (faint ? 0.4 : 1);
        for (const c of cent) {
          if (ga !== null && c.g.id !== ga) continue;
          let [x, y] = toScreen(c.x, c.y);
          const t = short(c.g), big = c.g.size > 60;
          ctx.font = `700 ${big ? 18 : 15}px ${font}`;
          ctx.letterSpacing = "1px";
          const dy = place(x, y + 20, ctx.measureText(t).width + 8, 40, !faint);
          if (dy === null) { ctx.letterSpacing = "0px"; continue; }
          y += dy;
          ctx.lineWidth = 5; ctx.strokeStyle = bg; ctx.strokeText(t, x, y);
          ctx.fillStyle = ink(color(c.g.id)); ctx.fillText(t, x, y);
          ctx.letterSpacing = "0px";
          ctx.font = `11px ${font}`;
          const s = `${c.g.size} 人`;
          ctx.lineWidth = 3; ctx.strokeText(s, x, y + 15); ctx.fillStyle = css("--text-2"); ctx.fillText(s, x, y + 15);
        }
        ctx.globalAlpha = 1;
      };
      if (mode === "map" && !fs) groupNames(false);
      // People's names: once you zoom in, in the ego view, for the person in focus and their people, and search hits.
      if (el.opt("labels").checked) {
        ctx.font = `12px ${font}`;
        ctx.lineWidth = 3; ctx.strokeStyle = bg; ctx.fillStyle = text;
        const zoomed = k > 2.2 * kFit;
        const named = new Set(mode === "map" && !fs && ga === null ? cent.map((c) => nodes.find((n) => n.g === c.g.id && n.name === c.g.lead)?.i) : []);
        const first = (n) => n.i === selected?.i || n === egoCenter || n.i === hover?.i;
        const order = [...vnodes].sort((a, b) => first(b) - first(a) || b.deg - a.deg);
        for (const n of order) {
          if (!visible(n)) continue;
          const dim = mode === "map" && dimmed(n, fs);
          const want = mode === "ego" || (fs && !dim) || first(n) || (!dim && zoomed) || (!dim && activeGroup !== null && n.r >= 6) || (query && !dim);
          if (!want || named.has(n.i)) continue;
          const [sx, sy] = toScreen(n.x, n.y - (n === egoCenter ? Math.min(n.r + 4, 15 / k) + 3 / k : n.r * (mode === "map" ? 0.85 : 1)));
          if (place(sx, sy - 4, ctx.measureText(n.name).width + 4, 14, false) === null && !first(n)) continue;
          ctx.globalAlpha = (dim ? 0.2 : 1) * late;
          ctx.strokeText(n.name, sx, sy - 4); ctx.fillText(n.name, sx, sy - 4);
        }
        ctx.globalAlpha = 1;
      }
      if (mode === "map" && fs) groupNames(true);
      ctx.restore();
    }

    function nodeAt(px, py) {
      const [x, y] = transform.invert([px - W / 2, py - H / 2]);
      let best = null, bd = Infinity;
      for (const n of vnodes) {
        if (!visible(n)) continue;
        const d = Math.hypot(n.x - x, n.y - y);
        if (d < n.r + 4 / transform.k && d < bd) { best = n; bd = d; }
      }
      return best && nodes[best.i];
    }

    // ---------------- side panels ----------------
    function openList(t) {
      const was = isOpen(el.list);
      if (t && t !== tab) { tab = t; renderSide(); }
      el.list.classList.toggle("open", !!t);
      if (t && narrow()) el.detail.classList.remove("open"); // one bottom sheet at a time on a narrow window
      for (const b of view.querySelectorAll("[data-open]")) b.setAttribute("aria-pressed", String(!!t && b.dataset.open === tab));
      if (!was && t) { hoverGroup = null; makeRoom(); }
    }
    const narrow = () => W < 720;

    function renderSide() {
      for (const b of view.querySelectorAll(".gp-tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
      for (const b of view.querySelectorAll("[data-open]")) b.setAttribute("aria-pressed", String(isOpen(el.list) && b.dataset.open === tab));
      if (tab === "recs") return renderRecs();
      const l2 = nodes.filter((n) => n.l2).length;
      el.scroll.innerHTML = `<div class="gp-sec"><p>你关注 ${stats.l1} 人（${stats.hidden} 人藏了关注列表），另有 ${l2} 个你没关注的。点一圈只看这一圈。</p>
          <div class="gp-ainame"><button type="button" data-ainame title="让 AI 看每圈的人和投稿，起个名字">${AI_NAME}</button></div></div>` +
        groups.map((g) => {
          const nm = gname(g);
          return `<div class="gp-grp${activeGroup === g.id ? " on" : ""}" data-g="${g.id}"><span class="gp-dot" style="background:${color(g.id)}"></span>
            <div><b>${esc(short(g))}</b><small>${esc(nm?.desc || glabel(g))}</small></div>
            <span class="gp-num">${g.size}</span><button type="button" class="link gp-rename" data-rename="${g.id}" title="给这个圈子改名" aria-label="改名">✎</button></div>`;
        }).join("") +
        `<div class="gp-grp${activeGroup === -1 ? " on" : ""}" data-g="-1"><span class="gp-dot" style="background:${color(-1)}"></span><div><b>零散的</b><small>和哪一圈都不太近</small></div><span class="gp-num">${nodes.filter((n) => n.g < 0).length}</span></div>`;
    }
    function renderRecs() {
      if (tab !== "recs" || !res) return;
      recs = BSGraph.recommend(res, recOpts());
      const followed = new Set(st.bs_followings?.list || []);
      el.scroll.innerHTML = `<div class="gp-sec"><p>你没关注、你关注的人很多都关注的。</p></div>` +
        recs.slice(0, 100).map((r) => {
          const n = nodes[r.i];
          const zone = n.zones[0]?.[0];
          const done = followed.has(n.mid);
          return `<div class="gp-rec${r.unfollowed ? " gone" : ""}" data-i="${r.i}" style="--c:${color(n.g)}">
            ${BS.avatar(n.face, 36)}
            <div class="nm">${BS.nameHtml(st.bs_people?.[n.mid], n.mid)}${zone ? `<small>${esc(zone)}</small>` : ""}${r.unfollowed ? '<span class="gp-tag">你取关过</span>' : ""}</div>
            <div class="why">${esc(r.reason)}</div>
            <button type="button" data-follow="${r.i}" ${done ? "disabled" : ""}>${done ? "已关注" : "关注"}</button></div>`;
        }).join("");
    }

    const mark = (j) => `<i class="${nodes[j].l2 ? "ring" : "dot"}" style="--c:${color(nodes[j].g)}"></i>`;
    function li(list) {
      return list.slice(0, 30).map((j) => `<li data-i="${j}">${mark(j)}<span>${esc(nodes[j].name)}</span></li>`).join("") || "<li class='none'>无</li>";
    }
    // Most-alike list with a bar for how alike (0–1 similarity), so 「越近越像」 reads without the map.
    // The bar spans this list's own range (the 8 are often close), the exact similarity is in the tooltip.
    function liNear(n) {
      const near = n.near.slice(0, 8), hi = near[0]?.[1] || 1, lo = near.at(-1)?.[1] ?? 0;
      return near.map(([j, s]) => `<li data-i="${j}" title="相似度 ${Math.round(s * 100)}%">${mark(j)}<span>${esc(nodes[j].name)}</span><span class="bar"><b style="width:${Math.round(30 + 70 * (hi > lo ? (s - lo) / (hi - lo) : 1))}%"></b></span></li>`).join("") || "<li class='none'>无</li>";
    }
    function showDetail(n) {
      const was = isOpen(el.detail);
      el.detail.classList.toggle("open", !!n);
      if (n && narrow()) { el.list.classList.remove("open"); for (const b of view.querySelectorAll("[data-open]")) b.setAttribute("aria-pressed", "false"); }
      if (!was && n) requestAnimationFrame(makeRoom);
      if (!n) return;
      const byDeg = (a, b) => nodes[b].deg - nodes[a].deg;
      const follows = [...n.outIn].sort(byDeg), fans = [...n.followers].sort(byDeg);
      const g = groups[n.g];
      el.detail.innerHTML = `
        <button type="button" class="link gp-x" data-close="detail" aria-label="关闭">✕</button>
        <div class="who">${BS.avatar(n.face, 44)}
          <div><a href="https://space.bilibili.com/${esc(n.mid)}" target="_blank" rel="noopener">${BS.nameHtml(st.bs_people?.[n.mid], n.mid)}</a>
          <div class="meta">${n.l2 ? "你还没关注" : "你关注了"} · 你关注的人里 ${n.deg} 人关注 TA${n.hidden ? " · 关注列表隐藏" : ""}</div></div></div>
        <div class="gp-acts">${mode === "ego" && egoCenter?.i === n.i ? "" : `<button type="button" class="primary" data-ego="${n.i}">以 TA 为中心</button>`}${n.l2 ? `<button type="button" data-follow="${n.i}" ${new Set(st.bs_followings?.list || []).has(n.mid) ? "disabled>已关注" : ">关注"}</button>` : ""}</div>
        ${g ? `<div class="meta grp"><i class="dot" style="--c:${color(g.id)}"></i>圈子：<b>${esc(short(g))}</b><span class="muted">${esc(g.zones.join("·"))}</span></div>` : ""}
        ${n.sign ? `<div class="sign" title="${esc(n.sign)}">${esc(n.sign)}</div>` : ""}
        ${n.vcount != null ? `<div class="meta">投稿 ${n.vcount} 个${n.zones.length ? " · " + n.zones.map(([z, c]) => `${esc(z)} ${c}`).join("、") : ""}${n.last ? " · 最后投稿 " + BS.fmtAgo(n.last) : ""}</div>` : ""}
        <h4>和 TA 最像的</h4><ul class="near">${liNear(n)}</ul>
        ${n.l2 ? "" : `<h4>TA 关注了 <small>图里 ${follows.length} 人</small></h4><ul>${li(follows)}</ul>`}
        <h4>你关注的人里关注 TA 的 <small>${fans.length} 人</small></h4><ul>${li(fans)}</ul>`;
      el.detail.scrollTop = 0;
    }

    function focusNode(n) {
      selected = n; hover = null; el.tip.hidden = true; showDetail(n);
      if (fg) { fly3D(n); paint3D(); return; }
      const p = pos(n.i);
      if (!p) { leaveEgo(); return; }
      if (!visible(p)) { if (n.l2) el.opt("l2").checked = true; if (n.iso) el.opt("iso").checked = true; }
      // Frame the person with everyone the focus draws (most alike, follows, followers) in the room the panels leave,
      // centered on the person, after the detail panel has taken its place.
      requestAnimationFrame(() => {
        const q = room(), w = W - q.l - q.r, h = H - q.t - q.b;
        const set = mode === "map" ? [...focusSet()].map((j) => nodes[j]).filter(visible) : [p];
        const rx = Math.max(40, ...set.map((m) => Math.abs(m.x - p.x))), ry = Math.max(40, ...set.map((m) => Math.abs(m.y - p.y)));
        const k = Math.max(0.8 * kFit, Math.min(3 * kFit, 0.9 * Math.min(w / (2 * rx), h / (2 * ry))));
        const t = d3.zoomIdentity.translate((q.l - q.r) / 2, (q.t - q.b) / 2).scale(k).translate(-p.x, -p.y);
        d3.select(el.cv).transition().duration(calm() ? 0 : 500).call(zoom.transform, t);
      });
    }

    // ---------------- events ----------------
    function wire() {
      transform = d3.zoomIdentity;
      zoom = d3.zoom().scaleExtent([0.1, 12]).on("zoom", (e) => { transform = e.transform; draw(); });
      d3.select(el.cv).call(zoom).on("dblclick.zoom", null);
      const ro = new ResizeObserver(() => resize());
      ro.observe(el.stage);
      offs.push(() => ro.disconnect());
      const mq = matchMedia("(prefers-color-scheme: dark)");
      const onScheme = () => { draw(); if (fg) { fg.backgroundColor(css("--bg")); paint3D(); } };
      mq.addEventListener("change", onScheme);
      offs.push(() => mq.removeEventListener("change", onScheme), () => dispose3D());

      el.cv.addEventListener("mousemove", (e) => {
        const r = el.cv.getBoundingClientRect();
        const n = nodeAt(e.clientX - r.left, e.clientY - r.top);
        if (n !== hover) { hover = n; draw(); }
        el.tip.hidden = !n;
        if (n) {
          el.tip.style.left = Math.min(e.clientX - r.left + 14, W - 220) + "px";
          el.tip.style.top = e.clientY - r.top + 14 + "px";
          el.tip.innerHTML = `<b>${esc(n.name)}</b>${n.l2 ? "（你还没关注）" : ""}<br>你关注的人里 ${n.deg} 人关注 TA`;
        }
      });
      el.cv.addEventListener("mouseleave", () => { hover = null; el.tip.hidden = true; draw(); });
      el.cv.addEventListener("click", (e) => {
        const r = el.cv.getBoundingClientRect();
        selected = nodeAt(e.clientX - r.left, e.clientY - r.top);
        showDetail(selected); draw();
      });
      el.bar.querySelector("button").onclick = leaveEgo;
      view.querySelector(".gp-show").addEventListener("toggle", (e) => e.target.open && closeOnOutside(e.target));

      el.stage.addEventListener("click", async (e) => {
        const close = e.target.closest("[data-close]")?.dataset.close;
        if (close === "list") return openList(null);
        if (close === "detail") { selected = null; showDetail(null); draw(); paint3D(); return; }
        const op = e.target.closest("[data-open]")?.dataset.open;
        if (op) return openList(isOpen(el.list) && tab === op ? null : op);
        const t = e.target.closest("[data-tab]")?.dataset.tab;
        if (t && t !== tab) { tab = t; renderSide(); return; }
        const ego = e.target.closest("[data-ego]")?.dataset.ego;
        if (ego !== undefined) return enterEgo(nodes[+ego]);
        const i = e.target.closest("li[data-i]")?.dataset.i;
        if (i !== undefined) return focusNode(nodes[+i]);
        const fb = e.target.closest("[data-follow]");
        if (fb) {
          const n = nodes[+fb.dataset.follow];
          if (!(await BS.confirm(`关注「${n.name}」？`, { ok: "关注" }))) return;
          fb.disabled = true;
          try {
            await BS.send("bs-follow", { mid: n.mid, act: 1 });
            st.bs_followings = await BS.get("bs_followings");
            fb.textContent = "已关注";
            BS.toast(`已关注 ${n.name}`);
          } catch (err) { BS.toast(err, { error: true }); fb.disabled = false; }
          return;
        }
        if (e.target.closest("[data-ainame]")) return aiName(e.target.closest("[data-ainame]"));
        const rn = e.target.closest("[data-rename]")?.dataset.rename;
        if (rn !== undefined) return rename(groups[+rn]);
        const rec = e.target.closest(".gp-rec")?.dataset.i;
        if (rec !== undefined) { if (mode === "ego") leaveEgo(); return focusNode(nodes[+rec]); }
        const g = e.target.closest(".gp-grp[data-g]");
        if (!g) return;
        if (mode === "ego") leaveEgo();
        activeGroup = activeGroup === +g.dataset.g ? null : +g.dataset.g;
        view.querySelectorAll(".gp-grp[data-g]").forEach((x) => x.classList.toggle("on", +x.dataset.g === activeGroup));
        selected = null; showDetail(null); draw(); paint3D();
        if (fg) { labels3D(); fg.zoomToFit(800, 40, (d) => activeGroup === null || d.n.g === activeGroup); }
        else fit(true, activeGroup);
      });
      // Pointing at a 圈子 row lights that 圈子 on the map; pointing at a recommendation rings that person.
      el.scroll.addEventListener("mouseover", (e) => {
        const g = e.target.closest(".gp-grp[data-g]")?.dataset.g;
        const v = g === undefined ? null : +g;
        const ri = e.target.closest(".gp-rec")?.dataset.i;
        const h = ri === undefined ? (tab === "recs" ? null : hover) : nodes[+ri];
        if (v !== hoverGroup || h !== hover) { hoverGroup = v; hover = h; draw(); paint3D(); }
      });
      el.scroll.addEventListener("mouseleave", () => { hoverGroup = null; if (tab === "recs") hover = null; draw(); paint3D(); });
      el.search.addEventListener("input", () => { query = el.search.value.trim().toLowerCase(); activeGroup = null; selected = null; showDetail(null); draw(); paint3D(); });
      el.search.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || !query) return;
        const n = nodes.filter((n) => n.name.toLowerCase().includes(query)).sort((a, b) => b.deg - a.deg)[0];
        if (!n) return BS.toast("图里没有这个名字");
        if (mode === "ego" && !egoBy.has(n.i)) leaveEgo();
        focusNode(n);
      });
      for (const k of ["l2", "labels", "iso"]) el.opt(k).addEventListener("change", () => { draw(); paint3D(); });
      el.alpha.addEventListener("change", async () => {
        alpha = Math.round((1 - Number(el.alpha.value)) * 100) / 100;
        const settings = (await BS.get("bs_settings")) || {};
        await chrome.storage.local.set({ bs_settings: { ...settings, alpha } });
        el.loading.hidden = false; el.loading.textContent = "正在计算关系…";
        setTimeout(run, 30);
      });
      view.querySelector(".gp-stale button").onclick = () => { dispose3D(); res = null; laidOut = false; load(); };
      view.querySelector(".gp-seg").addEventListener("click", (e) => {
        const d = e.target.closest("[data-dim]")?.dataset.dim;
        if (d) setDim(+d);
      });
    }
    // The 显示 menu closes on a click anywhere else.
    function closeOnOutside(d) {
      const off = (e) => { if (!d.contains(e.target)) { d.open = false; document.removeEventListener("pointerdown", off); } };
      document.addEventListener("pointerdown", off);
    }

    // ---------------- 3D ----------------
    async function setDim(d) {
      for (const b of view.querySelectorAll("[data-dim]")) b.setAttribute("aria-pressed", String(+b.dataset.dim === d));
      if (d === 2) { dispose3D(); el.cv.hidden = false; resize(); return; }
      if (mode === "ego") leaveEgo();
      if (!window.ForceGraph3D) {
        el.loading.hidden = false; el.loading.textContent = "正在加载立体视图…";
        try {
          await new Promise((ok, fail) => {
            const s = document.createElement("script");
            s.src = chrome.runtime.getURL("vendor/3d-force-graph.min.js");
            s.onload = ok; s.onerror = () => fail(new Error("立体视图没加载出来"));
            document.head.append(s);
          });
        } catch (err) { BS.toast(err, { error: true }); el.loading.hidden = true; return setDim(2); }
        el.loading.hidden = true;
      }
      if (!alive || view.querySelector('[data-dim="2"][aria-pressed="true"]')) return;
      el.cv.hidden = true; el.tip.hidden = true;
      build3D();
    }

    function build3D() {
      dispose3D();
      const box = document.createElement("div");
      box.className = "gp-3d";
      el.stage.prepend(box);
      // Cluster anchors on a Fibonacci sphere (biggest clusters first); members pull toward theirs
      const G = groups.length, R = 70 * Math.cbrt(G + 1);
      const anchors = groups.map((g, k) => {
        const y = 1 - (2 * (k + 0.5)) / G, rr = Math.sqrt(1 - y * y), t = k * 2.39996;
        return [R * rr * Math.cos(t), R * y, R * rr * Math.sin(t)];
      });
      const anc = (d) => (d.n.g >= 0 ? anchors[d.n.g] : [0, 0, 0]);
      const n3 = nodes.map((n, i) => { const a = anc({ n }); return { id: i, n, x: a[0] + Math.random() * 20 - 10, y: a[1] + Math.random() * 20 - 10, z: a[2] + Math.random() * 20 - 10 }; });
      const l3 = res.edges.filter(([a, b]) => nodes[a].g >= 0 && nodes[a].g === nodes[b].g).map(([a, b]) => ({ source: a, target: b }));
      const pull = (alpha) => {
        for (const d of n3) {
          const a = anc(d), s = (d.n.g >= 0 ? 0.12 : 0.02) * alpha;
          d.vx += (a[0] - d.x) * s; d.vy += (a[1] - d.y) * s; d.vz += (a[2] - d.z) * s;
        }
      };
      const r3 = (n) => 1.5 + Math.sqrt(n.deg) * 0.9;
      fg = ForceGraph3D({ controlType: "orbit" })(box)
        .width(W).height(H)
        .backgroundColor(css("--bg"))
        .showNavInfo(false)
        .nodeRelSize(1)
        .nodeVal((d) => r3(d.n) ** 3)
        .nodeOpacity(0.92)
        .nodeLabel((d) => `<b>${esc(d.n.name)}</b>${d.n.l2 ? "（你还没关注）" : ""}<br>你关注的人里 ${d.n.deg} 人关注 TA`)
        .linkOpacity(0.12)
        .linkWidth(0)
        .onNodeClick((d) => { selected = d.n; showDetail(d.n); fly3D(d.n); paint3D(); })
        .onBackgroundClick(() => { selected = null; showDetail(null); paint3D(); })
        .warmupTicks(120)
        .cooldownTicks(150);
      fg.d3Force("anchor", pull);
      fg.d3Force("charge").strength(-25);
      fg.d3Force("link").distance(16);
      fg.graphData({ nodes: n3, links: l3 });
      // 你还没关注 in 3D: the same hollow ring as 2D. Rings are flat meshes turned toward the camera every frame (billboards), so
      // they read as a hollow circle from any angle. three.js isn't global here, so the classes come from a built node.
      halo = { on: true };
      const ringGeo = (inner, outer, seg = 40) => {
        const pos = [];
        for (let k = 0; k < seg; k++) {
          const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
          const p = (r, a) => [r * Math.cos(a), r * Math.sin(a), 0];
          pos.push(...p(inner, a0), ...p(outer, a0), ...p(outer, a1), ...p(inner, a0), ...p(outer, a1), ...p(inner, a1));
        }
        const g = new T.Geo();
        g.setAttribute("position", new T.Attr(new Float32Array(pos), 3));
        g.computeVertexNormals();
        return g;
      };
      const mat = (c, extra = {}) => Object.assign(new T.Mat({ color: c, emissive: c, transparent: true, depthWrite: false, ...extra }), { side: 2 });
      const shells = () => {
        T ??= (() => {
          const o = n3.find((d) => d.__threeObj?.material?.type === "MeshLambertMaterial")?.__threeObj;
          return o && { Mesh: o.constructor, Sphere: o.geometry.constructor, Geo: Object.getPrototypeOf(o.geometry.constructor.prototype).constructor, Attr: o.geometry.attributes.position.constructor, Mat: o.material.constructor };
        })();
        if (!T) return false;
        fg.nodeThreeObjectExtend((d) => !d.n.l2).nodeThreeObject((d) => {
          if (!d.n.l2) return null;
          const r = r3(d.n), c = color(d.n.g);
          const ring = new T.Mesh(ringGeo(r * 0.72, r), mat(c, { opacity: 0.95 }));
          ring.onBeforeRender = (_r, _s, cam) => ring.quaternion.copy(cam.quaternion);
          return (d.shell = ring);
        });
        paint3D();
        return true;
      };
      paint3D();
      if (!shells()) requestAnimationFrame(function again() { if (fg && !shells()) requestAnimationFrame(again); });
      labels3D();
    }
    let halo = { on: null };
    // 3D keeps the 圈子 names (HTML labels that follow each cluster's middle on screen); territories would only fog the view.
    function labels3D() {
      if (!fg) return;
      el.stage.querySelector(".gp-3dlabels")?.remove();
      const box = document.createElement("div");
      box.className = "gp-3dlabels";
      box.innerHTML = groups.map((g) => `<span data-g="${g.id}" style="color:${ink(color(g.id))}"${activeGroup !== null && activeGroup !== g.id ? " hidden" : ""}>${esc(short(g))}</span>`).join("");
      el.stage.querySelector(".gp-3d").after(box);
      const spans = [...box.children];
      const members = groups.map((g) => fg.graphData().nodes.filter((d) => d.n.g === g.id));
      const me = fg;
      (function tick() {
        if (fg !== me || !box.isConnected) return;
        const boxes = []; // biggest 圈子 first; a name that would sit on one already shown waits for the camera to turn
        members.forEach((m, k) => {
          const c = [0, 0, 0];
          for (const d of m) { c[0] += d.x; c[1] += d.y; c[2] += d.z; }
          const p = fg.graph2ScreenCoords(c[0] / m.length, c[1] / m.length, c[2] / m.length);
          const w = (spans[k].offsetWidth || 60) / 2 + 4, r = [p.x - w, p.y - 11, p.x + w, p.y + 11];
          const free = !boxes.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]);
          if (free && !spans[k].hidden) boxes.push(r);
          spans[k].style.opacity = free ? "" : "0";
          spans[k].style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
        });
        requestAnimationFrame(tick);
      })();
    }
    // Colors and visibility follow the same toggles, legend, search and selection as 2D.
    function paint3D() {
      if (!fg) return;
      const fs = focusSet();
      const at = (x) => (typeof x === "object" ? x : fg.graphData().nodes[x]); // links hold indices until the layout resolves them
      const ga = hoverGroup ?? activeGroup;
      const vis = (d) => visible(d.n) && (activeGroup === null || d.n.g === activeGroup);
      const edge = css("--text");
      const dimOf = (d) => (fs ? !fs.has(d.n.i) : ga !== null ? d.n.g !== ga : query && !d.n.name.toLowerCase().includes(query));
      if (halo.on) {
        for (const d of fg.graphData().nodes) if (d.shell) {
          d.shell.material.opacity = dimOf(d) ? 0.08 : 0.95;
        }
      }
      fg.nodeVisibility(vis)
        .linkVisibility((l) => vis(at(l.source)) && vis(at(l.target)))
        .linkColor(() => edge)
        .nodeColor((d) => {
          const c = color(d.n.g);
          return dimOf(d) ? c + "33" : c;
        });
      for (const s of el.stage.querySelectorAll(".gp-3dlabels span")) s.classList.toggle("dim", !!fs || (ga !== null && +s.dataset.g !== ga));
    }
    function fly3D(n) {
      const d = fg.graphData().nodes[n.i];
      if (!visible(n)) { if (n.l2) el.opt("l2").checked = true; if (n.iso) el.opt("iso").checked = true; }
      if (activeGroup !== null && n.g !== activeGroup) { activeGroup = null; labels3D(); }
      const h = Math.hypot(d.x, d.y, d.z) || 1, k = 1 + 200 / h;
      fg.cameraPosition({ x: d.x * k, y: d.y * k, z: d.z * k }, d, 1000);
    }
    function dispose3D() {
      if (!fg) return;
      fg.pauseAnimation();
      fg._destructor?.();
      fg = null;
      view.querySelector(".gp-3d")?.remove();
      view.querySelector(".gp-3dlabels")?.remove();
    }

    load();
  }
})();
