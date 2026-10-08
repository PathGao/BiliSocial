// App shell: top bar, hash router, sync panel, and the shared helpers pages use through window.BS.
// Pages register with BS.page(name, { mount(el), unmount() }); BS.onStore listeners added during a page's mount
// are removed automatically when the page unmounts.
// Plain words for an error that reaches the UI: an Error with .code, or a stored message like
// 「拉我的关注失败：B站返回 -101：账号未登录」. Known B站 codes get a sentence; unknown ones 「B站 返回错误（代码 X）」.
const ERR_WORDS = {
  "-101": "B站 没登录，先在这个浏览器登录 B站", NOT_LOGGED_IN: "B站 没登录，先在这个浏览器登录 B站",
  "-352": "被 B站 限流，过一阵再试", "-412": "被 B站 限流，过一阵再试", "-799": "被 B站 限流，过一阵再试", "-509": "被 B站 限流，过一阵再试",
  412: "被 B站 限流，过一阵再试", THROTTLED: "被 B站 限流，过一阵再试",
  22115: "对方隐藏了关注列表", "-404": "账号不存在或已注销", "-403": "B站 拒绝了请求，可能要重新登录",
  NETWORK: "网络断了"
};
function errText(e) {
  const msg = String(e?.message ?? e ?? "");
  const m = msg.match(/B站返回 (-?\d+)|HTTP (\d+)/);
  const code = e?.code ?? (m ? m[1] || m[2] : undefined);
  if (code === undefined || code === null || code === "STOPPED") return msg;
  const words = ERR_WORDS[code] || (/^-?\d+$/.test(String(code)) ? `B站 返回错误（代码 ${code}）` : "");
  if (!words) return msg;
  const before = m?.[1] ? msg.slice(0, m.index).replace(/[：:，,\s]+$/, "") : "";
  return before && !before.includes(words) ? `${before}：${words}` : words;
}

// A person's name for display: 「未获取名字」 when B站 gave none (never the bare mid), and whether the account is gone.
function nameOf(p, mid) {
  const name = p?.name && p.name !== String(mid) ? p.name : "";
  return { name: name || "未获取名字", missing: !name, gone: !!p?.gone };
}

if (typeof module === "object") module.exports = { errText, nameOf };
else (() => {
  const TABS = [["follow", "关注"], ["feed", "动态"], ["fans", "粉丝"], ["graph", "关系图"], ["me", "我的位置"], ["settings", "设置"]];
  const JOBS = [["mine", "我的关注和粉丝"], ["circle", "关注的关注"], ["content", "投稿内容"], ["interactions", "互动记录"]];
  const pages = {};
  let current = null; // { name, def, subs }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // Unix seconds -> 「3 天前」.
  function fmtAgo(sec) {
    if (!sec) return "";
    const d = Math.max(0, Date.now() / 1000 - sec);
    if (d < 60) return "刚刚";
    if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
    if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
    if (d < 30 * 86400) return `${Math.floor(d / 86400)} 天前`;
    if (d < 365 * 86400) return `${Math.floor(d / (30 * 86400))} 个月前`;
    return `${Math.floor(d / (365 * 86400))} 年前`;
  }

  // 12345 -> 「1.2万」.
  function fmtCount(n) {
    n = Number(n) || 0;
    const short = (v, unit) => `${v.toFixed(1).replace(/\.0$/, "")}${unit}`;
    if (n >= 1e8) return short(n / 1e8, "亿");
    if (n >= 1e4) return short(n / 1e4, "万");
    return String(n);
  }

  // Round avatar <img> HTML; hdslb faces get a resized copy. no-referrer avoids B站 hotlink blocking.
  function avatar(face, size = 32) {
    const px = size * 2;
    const src = /hdslb\.com\//.test(face || "") && !/@/.test(face) ? `${face}@${px}w_${px}h_1c.webp` : face;
    const dim = `width="${size}" height="${size}"`;
    return src
      ? `<img class="avatar" src="${esc(src)}" ${dim} loading="lazy" referrerpolicy="no-referrer" alt="">`
      : `<span class="avatar" style="width:${size}px;height:${size}px"></span>`;
  }

  // Name HTML for a list: the name, or 「未获取名字」 with the mid in small text; 「已注销」 when the account is gone.
  function nameHtml(p, mid) {
    const n = nameOf(p, mid);
    return (n.missing ? `未获取名字<small class="bs-mid">${esc(mid)}</small>` : esc(n.name)) + (n.gone ? `<span class="bs-gone">已注销</span>` : "");
  }
  const nameText = (p, mid) => { const n = nameOf(p, mid); return n.missing ? `未获取名字（${mid}）` : n.name; };

  // One fixed spot at the bottom. Progress and success fade after 3 s; an error stays until its ✕ (a newer error
  // replaces it, a success never covers it). Error messages go through errText.
  const toastBox = document.createElement("div");
  toastBox.className = "toasts";
  toastBox.innerHTML = `<div class="toast error" role="alert" hidden><span></span><button type="button" class="link" aria-label="关闭">✕</button></div>
    <div class="toast" role="status" hidden></div>`;
  const [errEl, infoEl] = toastBox.children;
  errEl.querySelector("button").onclick = () => (errEl.hidden = true);
  let toastTimer = 0;
  function toast(message, { error = false } = {}) {
    if (!toastBox.isConnected) document.body.append(toastBox);
    if (error) {
      errEl.querySelector("span").textContent = errText(message);
      errEl.hidden = false;
      return;
    }
    infoEl.textContent = message;
    infoEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (infoEl.hidden = true), 3000);
  }

  // Resolves true when the user picks OK.
  function confirm(message, { ok = "确定", cancel = "取消", danger = false } = {}) {
    const dlg = document.createElement("dialog");
    dlg.className = "bs-confirm";
    dlg.innerHTML = `<p>${esc(message)}</p><form method="dialog" class="dialog-actions">
      <button value="">${esc(cancel)}</button><button value="ok" class="${danger ? "danger solid" : "primary"}">${esc(ok)}</button></form>`;
    document.body.append(dlg);
    dlg.showModal();
    // Buttons settle it directly: a background tab may never get the dialog's close event. Esc still goes through close.
    return new Promise((resolve) => {
      const done = (ok) => { resolve(ok); dlg.close(); dlg.remove(); };
      dlg.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); done(e.submitter?.value === "ok"); });
      dlg.addEventListener("close", () => done(false));
    });
  }

  const BS = {
    // Message the background; resolves with data or throws Error(error) with .code.
    async send(type, payload = {}) {
      const r = await chrome.runtime.sendMessage({ type, ...payload });
      if (!r?.ok) throw Object.assign(new Error(r?.error || "后台没有回应"), { code: r?.code });
      return r.data;
    },
    // A key name returns its value; an array of names returns { key: value }.
    async get(keys) {
      const got = await chrome.storage.local.get(keys);
      return typeof keys === "string" ? got[keys] : got;
    },
    // fn(changes) whenever one of `keys` changes; returns an unsubscribe function. Calls never overlap: changes that
    // arrive while an async fn runs are merged into one call after it, so an older read cannot land after a newer one.
    onStore(keys, fn) {
      const want = [].concat(keys);
      let busy = false, queued = null, dead = false;
      const run = async (changes) => {
        if (dead) return;
        if (busy) { queued = { ...queued, ...changes }; return; }
        busy = true;
        try { await fn(changes); } catch (e) { console.error(e); }
        busy = false;
        if (queued) { const next = queued; queued = null; run(next); }
      };
      const listener = (changes, area) => {
        if (area === "local" && want.some((k) => k in changes)) run(changes);
      };
      chrome.storage.onChanged.addListener(listener);
      const off = () => { dead = true; chrome.storage.onChanged.removeListener(listener); };
      current?.subs.push(off);
      return off;
    },
    esc, toast, confirm, fmtAgo, fmtCount, avatar, errText, nameOf, nameHtml, nameText,
    route(name) { location.hash = name; },
    page(name, def) {
      pages[name] = def;
      if (started && routeName() === name && current?.name !== name) render();
    }
  };
  window.BS = BS;

  // ---------- shell ----------
  document.body.insertAdjacentHTML("afterbegin", `
    <header class="topbar">
      <div class="brand"><img src="${chrome.runtime.getURL("icons/mark.svg")}" alt=""><span>B站社交圈</span></div>
      <nav class="nav" aria-label="页面">${TABS.map(([id, label]) => `<a href="#${id}" data-tab="${id}">${label}</a>`).join("")}</nav>
      <div class="sync">
        <button id="syncPill" type="button" class="sync-pill" popovertarget="syncPanel">同步</button>
        <div id="syncPanel" class="sync-panel" popover>
          <div class="sync-head" id="syncHead"></div>
          <div id="jobList"></div>
        </div>
      </div>
    </header>
    <div id="staleBar" class="stale-bar" hidden></div>
    <main id="view" class="view"></main>`);
  const view = document.getElementById("view");
  const pill = document.getElementById("syncPill");
  const jobList = document.getElementById("jobList");
  const head = document.getElementById("syncHead");

  const routeName = () => {
    const name = location.hash.slice(1).split("?")[0]; // #feed?tag=<id> carries page state after the ?
    return TABS.some(([id]) => id === name) ? name : "follow";
  };

  function render() {
    const name = routeName();
    if (current) {
      for (const off of current.subs) off();
      try { current.def.unmount?.(); } catch (e) { console.error(e); }
    }
    for (const a of document.querySelectorAll(".nav a")) {
      if (a.dataset.tab === name) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    view.replaceChildren();
    const def = pages[name];
    current = def ? { name, def, subs: [] } : null;
    if (!def) {
      view.innerHTML = `<p class="empty">这个页面没加载</p>`;
      return;
    }
    try {
      def.mount(view);
    } catch (e) {
      console.error(e);
      view.innerHTML = `<p class="empty">页面出错了：${esc(e.message)}</p>`;
    }
  }

  // ---------- sync ----------
  const nowSec = () => Date.now() / 1000;
  const fmtSpan = (sec) => (sec < 120 ? `${Math.ceil(sec)} 秒` : sec < 5400 ? `${Math.round(sec / 60)} 分钟` : `${(sec / 3600).toFixed(1).replace(/\.0$/, "")} 小时`);
  // Seconds of queue time per unit when nothing is measured yet (circle: up to 5 pages per account).
  const PER_UNIT = { circle: 2.5, content: 1.25 };
  const pace = {}; // job -> { t, done, step }: where this page started watching the current step
  // 「还要约 40 分钟」 from the speed seen since this page opened; before 30 s of it, a guess that counts the jobs
  // sharing the ~1 req/s queue.
  function eta(id, j, k) {
    if (!j.total || j.done >= j.total) return "";
    let p = pace[id];
    if (!p || p.step !== j.step || j.done < p.done) p = pace[id] = { t: nowSec(), done: j.done, step: j.step };
    const left = j.total - j.done;
    const took = nowSec() - p.t;
    if (took >= 30 && j.done - p.done >= 3) return ` · 还要约 ${fmtSpan((left * took) / (j.done - p.done))}`;
    return PER_UNIT[id] ? ` · 还要约 ${fmtSpan(left * PER_UNIT[id] * k)}` : "";
  }
  // A running job waiting out a pause of the shared queue: 「被 B站 限流，85 秒后重试」.
  function holdText(j) {
    const left = j?.running && j.hold ? j.hold.until - nowSec() : 0;
    if (left <= 0) return "";
    const why = j.hold.why === "network" ? "网络断了" : "被 B站 限流";
    return `${why}，${fmtSpan(left)}后重试（第 ${j.hold.n}/${j.hold.of} 次）`;
  }

  function jobLine(id, j, k) {
    if (!j) return { text: "还没开始" };
    const prog = j.total ? ` ${j.done}/${j.total}` : "";
    const held = holdText(j);
    if (held) return { text: held, cls: "warn" };
    if (j.running) return { text: `正在${j.step || "准备"}${prog}${eta(id, j, k)}` };
    if (j.after === "content") return { text: `排队中：「投稿内容」完成后自动开始${prog ? ` ·${prog}` : ""}` };
    if (j.throttled) return { text: "被 B站 限流，已暂停。过一阵再点继续", cls: "warn" };
    if (j.error) return { text: `出错了：${errText(j.error)}`, cls: "danger" };
    if (j.finishedAt) return { text: `已完成 · ${fmtAgo(j.finishedAt)}` };
    return { text: `已暂停${prog}` };
  }

  let lastJobs = {};
  function renderJobs(jobs = {}) {
    lastJobs = jobs;
    const runs = JOBS.filter(([id]) => jobs[id]?.running);
    const k = runs.length;
    head.textContent = k > 1
      ? `${k} 项共用每秒约 1 个请求，各自都慢些。被限流会自动等一会再试。`
      : "每秒约 1 个请求，被限流会自动等一会再试。";
    // The one blue button: the first job that has never finished and is not running or queued.
    const next = JOBS.find(([id]) => !jobs[id]?.finishedAt && !jobs[id]?.running && !jobs[id]?.after)?.[0];
    jobList.innerHTML = JOBS.map(([id, label]) => {
      const j = jobs[id];
      const line = jobLine(id, j, k);
      const busy = j?.running || j?.after;
      // What 「again」 really does differs per job: mine and interactions start over; content re-reads the video feed
      // and adds new follows; circle checks page 1 of each list plus new follows (a full re-crawl is offered after 30 days).
      // interactions: 同步新互动 redoes only videos, notifications and PM sessions that changed; 完整重扫 starts from nothing.
      // 「更新」 alone is kept for 更新最近投稿 only, so one word never means two things.
      const again = { mine: "重新同步", content: "更新最近投稿", circle: "更新关注的关注", interactions: "同步新互动" }[id];
      const btn = j?.running ? "停止" : j?.after ? "取消排队" : j?.finishedAt ? again : j?.done || j?.cursor ? "继续" : "开始";
      const full = id === "circle" && !busy && j?.lastFinishedAt && Date.now() / 1000 - j.lastFinishedAt > 30 * 86400
        ? `<button type="button" data-job="circle" data-act="start" data-full="1">全部重查（约 50 分钟）</button>`
        : id === "interactions" && !busy && j?.finishedAt ? `<button type="button" data-job="interactions" data-act="start" data-full="1">完整重扫（约 20 分钟）</button>` : "";
      const pct = j?.running && j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : 0;
      return `<div class="job">
        <div class="job-name">${label}</div>
        <div class="job-line ${line.cls || ""}" ${j?.running ? 'aria-busy="true"' : ""}>${esc(line.text)}</div>
        ${pct ? `<div class="job-bar"><i style="width:${pct}%"></i></div>` : ""}
        <button type="button" data-job="${id}" data-act="${busy ? "stop" : "start"}" class="${id === next ? "primary" : ""}">${btn}</button>${full}
      </div>`;
    }).join("");

    const run = runs[0];
    const held = runs.map(([id]) => holdText(jobs[id])).find(Boolean);
    const throttled = JOBS.some(([id]) => jobs[id]?.throttled && !jobs[id]?.running);
    const failed = JOBS.some(([id]) => jobs[id]?.error && !jobs[id]?.running);
    // Red only for an error to act on; amber for a wait (限流 countdown or a throttled stop); gray otherwise, no dot.
    pill.className = "sync-pill" + (held || (!run && throttled) ? " warn" : !run && failed ? " danger" : run ? " running" : "");
    if (run) {
      const j = jobs[run[0]];
      pill.setAttribute("aria-busy", "true");
      pill.textContent = held ? held.replace(/（.*）$/, "") : k > 1 ? `${k} 项在同步` : `同步${run[1]}${j.total ? ` ${j.done}/${j.total}` : ""}`;
    } else {
      pill.removeAttribute("aria-busy");
      pill.textContent = throttled ? "被 B站 限流" : failed ? "同步出错" : "同步";
    }
  }
  // Coming back after a while: offer one click that brings 关注/粉丝 and 活跃/慢更/断更 up to date (mine → content).
  const staleBar = document.getElementById("staleBar");
  let staleDismissed = false;
  function renderStale(jobs = {}) {
    const last = jobs.mine?.lastFinishedAt || jobs.mine?.finishedAt;
    const busy = JOBS.some(([id]) => jobs[id]?.running);
    const old = last && Date.now() / 1000 - last > 12 * 3600;
    staleBar.hidden = !old || busy || staleDismissed;
    if (staleBar.hidden) return;
    staleBar.innerHTML = `关注、粉丝和活跃情况是 ${esc(fmtAgo(last))}的。
      <button type="button" data-refresh>重新同步（约 5 分钟）</button>
      <button type="button" class="link" data-dismiss>先不用</button>`;
  }
  staleBar.addEventListener("click", async (e) => {
    if (e.target.closest("[data-dismiss]")) { staleDismissed = true; staleBar.hidden = true; return; }
    if (!e.target.closest("[data-refresh]")) return;
    e.target.disabled = true;
    try { await BS.send("bs-job-start", { job: "mine" }); } catch (err) { toast(err, { error: true }); e.target.disabled = false; }
  });

  // Countdowns (限流 / 网络) tick even when bs_jobs does not change.
  setInterval(() => { if (JOBS.some(([id]) => holdText(lastJobs[id]))) renderJobs(lastJobs); }, 1000);

  jobList.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-job]");
    if (!btn) return;
    btn.disabled = true;
    try {
      await BS.send(btn.dataset.act === "stop" ? "bs-job-stop" : "bs-job-start", { job: btn.dataset.job, opts: btn.dataset.full ? { full: true } : null });
    } catch (err) {
      toast(err, { error: true });
    } finally {
      btn.disabled = false;
    }
  });

  let started = false;
  window.addEventListener("DOMContentLoaded", async () => {
    started = true;
    window.addEventListener("hashchange", render);
    render();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.bs_jobs) { renderJobs(changes.bs_jobs.newValue); renderStale(changes.bs_jobs.newValue); }
    });
    const jobs0 = await BS.get("bs_jobs");
    renderJobs(jobs0);
    renderStale(jobs0);
  });
})();
