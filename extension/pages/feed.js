// #feed (动态): the 关注 video feed, filtered by my UP tags. Pages come from the background (bs-feed { offset }, cached
// there for a few minutes); tags from bs_up_tags / bs_up_tag_map. #feed?tag=<id> picks a tag (the chips on B站 pages
// link here); tag=untagged = 未打标签. Scrolling loads more, but stops after a few pages with nothing for the chosen
// tag and waits for 「加载更多」, so a rare tag never pages through the whole feed by itself.
// Items are kept newest first. Clicking a video plays it in a viewer on the right (the B站 video page in an iframe,
// trimmed by content/viewer-frame.*); the list then becomes a compact column on the left. Tag links switch with
// pushState instead of a hash change, so the page is not remounted and the video keeps playing.
(() => {
  const { esc, fmtAgo, fmtCount, avatar } = BS;
  const DRY_PAGES = 3; // auto-load stops after this many pages in a row without a video for the chosen tag
  const KEEP_MS = 5 * 60 * 1000; // matches the background cache; older lists start over on the next visit
  // Survives unmount so coming back keeps what was loaded.
  let F = null; // { items, offset, hasMore, loading, error, code, dry, at }
  let root = null;
  let D = { tags: [], map: {} };
  let tag = "all";
  let io = null;
  let viewing = null; // the item playing in the viewer, or null
  const video = (bvid) => `https://www.bilibili.com/video/${bvid}`;

  // Pure: adds a page to the loaded items, dropping videos already there, newest first (B站 pages can overlap or
  // come slightly out of order). Ties keep the order they came in.
  function merge(items, page) {
    const seen = new Set(items.map((it) => it.bvid));
    const add = page.filter((it) => !seen.has(it.bvid) && seen.add(it.bvid));
    return { items: [...items, ...add].sort((a, b) => (b.at || 0) - (a.at || 0)), add };
  }

  const fresh = () => ({ items: [], offset: "", hasMore: true, loading: false, error: "", code: null, dry: 0, at: Date.now() });
  const tagOf = (id) => D.tags.find((t) => t.id === id);
  const idsOf = (mid) => (D.map[mid] || []).filter((id) => tagOf(id));
  const match = (it) => (tag === "all" ? true : tag === "untagged" ? !idsOf(it.mid).length : idsOf(it.mid).includes(tag));
  const href = (t) => (t === "all" ? "#feed" : `#feed?tag=${encodeURIComponent(t)}`);
  // hdslb images: https and a small webp copy.
  const img = (u, size) => {
    const s = String(u || "").replace(/^(https?:)?\/\//, "https://");
    return /hdslb\.com\//.test(s) && !s.includes("@") ? `${s}@${size}.webp` : s;
  };
  const day = (sec) => {
    const d = new Date(sec * 1000);
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  };

  async function loadTags() {
    const got = await BS.get(["bs_up_tags", "bs_up_tag_map"]);
    D = { tags: got.bs_up_tags || [], map: got.bs_up_tag_map || {} };
    const want = new URLSearchParams(location.hash.split("?")[1] || "").get("tag") || "all";
    tag = want === "all" || want === "untagged" || tagOf(want) ? want : "all";
  }

  async function more({ byHand = false } = {}) {
    if (!F.hasMore || F.loading) return;
    if (byHand) F.dry = 0;
    F.loading = true;
    F.error = "";
    renderFoot();
    try {
      const page = await BS.send("bs-feed", { offset: F.offset });
      const { items, add } = merge(F.items, page.items);
      F.items = items;
      F.offset = page.offset;
      F.hasMore = page.hasMore && !!page.offset;
      F.dry = add.some(match) ? 0 : F.dry + 1;
    } catch (e) {
      F.error = `没拉到：${BS.errText(e)}`;
      F.code = e.code;
    } finally {
      F.loading = false;
    }
    if (root) render();
  }

  function card(it) {
    const chips = idsOf(it.mid).map(tagOf).map((t) => `<a class="fd-tag" href="${href(t.id)}" style="--c:${esc(t.color || "var(--link)")}">${esc(t.name)}</a>`).join("");
    const space = `https://space.bilibili.com/${esc(it.mid)}`;
    const on = viewing?.bvid === it.bvid;
    return `<article class="fd-card" data-bvid="${esc(it.bvid)}"${on ? ' aria-current="true"' : ""}>
      <a class="fd-cover" href="${esc(video(it.bvid))}" target="_blank" rel="noopener" data-play>
        ${it.cover ? `<img src="${esc(img(it.cover, "480w_270h_1c"))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}
        <span class="fd-stats">${it.play ? `<span>▶ ${fmtCount(it.play)}</span>` : ""}${it.duration ? `<span>${esc(it.duration)}</span>` : ""}</span>
      </a>
      <a class="fd-title" href="${esc(video(it.bvid))}" target="_blank" rel="noopener" data-play title="${esc(it.title)}">${esc(it.title)}</a>
      <div class="fd-meta">
        <a class="fd-up" href="${space}" target="_blank" rel="noopener">${avatar(img(it.face, "48w_48h_1c"), 20)}<span>${esc(it.name)}</span></a>
        <span class="fd-ago">${esc(fmtAgo(it.at))}</span>
      </div>
      ${chips ? `<div class="fd-tags">${chips}</div>` : ""}
    </article>`;
  }

  function render() {
    if (!root) return;
    const count = (fn) => F.items.filter(fn).length;
    const pills = [
      ["all", "全部", F.items.length, ""],
      ["untagged", "未打标签", count((it) => !idsOf(it.mid).length), ""],
      ...D.tags.map((t) => [t.id, t.name, count((it) => idsOf(it.mid).includes(t.id)), t.color])
    ];
    root.querySelector(".fd-pills").innerHTML = pills.map(([id, name, n, color]) =>
      `<a href="${href(id)}" class="fd-pill${F.items.length && !n ? " zero" : ""}" ${id === tag ? 'aria-current="true"' : ""}>${color ? `<i style="background:${esc(color)}"></i>` : ""}${esc(name)}<span>${F.items.length ? n : ""}</span></a>`).join("");
    root.querySelector(".fd-note").innerHTML = D.tags.length ? "" :
      `<p class="fd-hint">还没给 UP 主打标签。去 <a href="#follow">关注</a> 页给 UP 主打上标签，这里就能只看某一类 UP 主的新视频。下面先列出全部关注的新视频。</p>`;
    root.querySelector(".fd").classList.toggle("viewing", !!viewing);
    root.querySelector(".fd-viewer").hidden = !viewing;
    const list = F.items.filter(match);
    root.querySelector(".fd-grid").innerHTML = list.map(card).join("");
    renderFoot(list.length);
  }

  // Footer: how far back the feed was read, and the way to read further.
  function renderFoot(shown = F.items.filter(match).length) {
    const foot = root?.querySelector(".fd-foot");
    if (!foot) return;
    const oldest = F.items.length ? Math.min(...F.items.map((it) => it.at)) : 0;
    const name = tag === "untagged" ? "未打标签的 UP 主" : tag === "all" ? "" : `「${tagOf(tag)?.name}」的 UP 主`;
    const reach = oldest ? `已往前看到 ${day(oldest)}（${fmtAgo(oldest)}），共 ${F.items.length} 个视频。` : "";
    let text = "";
    if (F.error) text = F.error;
    else if (F.loading) text = F.items.length ? `${reach}正在加载更早的…` : "正在拉关注的新视频…";
    else if (!shown && F.items.length) text = `${name}最近没发视频。${reach}`;
    else if (!F.hasMore) text = F.items.length ? `${reach}B站 只给到这里。` : "关注的人最近都没发视频。";
    else text = reach;
    const btn = F.error ? `<button type="button" class="primary" data-more>重试</button>`
      : F.hasMore && !F.loading ? `<button type="button" class="${!shown || F.dry >= DRY_PAGES ? "primary" : ""}" data-more>加载更多</button>` : "";
    foot.innerHTML = `<p ${F.loading ? 'aria-busy="true"' : ""}>${esc(text)}</p>${btn}`;
    // Re-observe so a sentinel still on screen after this render asks for the next page.
    if (io) {
      io.unobserve(foot);
      io.observe(foot);
    }
  }

  const cardEl = (bvid) => bvid && root?.querySelector(`.fd-card[data-bvid="${CSS.escape(bvid)}"]`);

  function openViewer(it) {
    const first = !viewing;
    viewing = it;
    root.querySelector(".fd-vtitle").textContent = it.title;
    root.querySelector(".fd-vtitle").title = it.title;
    root.querySelector(".fd-vtab").href = video(it.bvid);
    root.querySelector(".fd-vframe").src = video(it.bvid);
    render();
    if (first) cardEl(it.bvid)?.scrollIntoView({ block: "center" });
  }

  function closeViewer() {
    if (!viewing) return;
    const was = viewing.bvid;
    viewing = null;
    root.querySelector(".fd-vframe").src = "about:blank";
    render();
    cardEl(was)?.scrollIntoView({ block: "center" });
  }

  async function retag() {
    await loadTags();
    F.dry = 0;
    render();
  }

  function onKey(e) {
    if (e.key === "Escape" && !e.isComposing && viewing && !document.querySelector(":popover-open, dialog[open]")) closeViewer();
  }

  BS.page("feed", {
    merge,
    async mount(el) {
      root = el;
      el.innerHTML = `<div class="fd">
        <nav class="fd-pills" aria-label="按标签看"></nav>
        <div class="fd-note"></div>
        <div class="fd-body">
          <div class="fd-list">
            <div class="fd-grid"></div>
            <div class="fd-foot"></div>
          </div>
          <aside class="fd-viewer" hidden>
            <div class="fd-vhead">
              <strong class="fd-vtitle"></strong>
              <a class="fd-vtab" target="_blank" rel="noopener">在 B站 打开</a>
              <button type="button" class="fd-vclose" data-close aria-label="关闭视频 (Esc)" title="关闭 (Esc)">✕</button>
            </div>
            <!-- No allow-top-navigation: B站 breaks out of frames by navigating the top window. -->
            <iframe class="fd-vframe" title="视频页" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-presentation" allow="autoplay; fullscreen; picture-in-picture; clipboard-write"></iframe>
          </aside>
        </div>
      </div>`;
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-more]")) return more({ byHand: true });
        if (e.target.closest("[data-close]")) return closeViewer();
        // Opening the video on B站 moves it there, so the viewer stops instead of playing along.
        if (e.target.closest(".fd-vtab")) return setTimeout(closeViewer);
        const a = e.target.closest("a");
        if (!a || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // modified clicks open a tab
        if (a.hasAttribute("data-play")) {
          const it = F.items.find((x) => x.bvid === a.closest(".fd-card").dataset.bvid);
          if (!it) return;
          e.preventDefault();
          openViewer(it);
        } else if (a.getAttribute("href")?.startsWith("#feed")) {
          e.preventDefault();
          history.pushState(null, "", a.getAttribute("href"));
          retag();
        }
      });
      document.addEventListener("keydown", onKey);
      if (!F || Date.now() - F.at > KEEP_MS) F = fresh();
      await loadTags();
      if (root !== el) return;
      F.dry = 0;
      render();
      io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting) && F.dry < DRY_PAGES && !F.error) more();
      }, { rootMargin: "400px 0px" });
      io.observe(el.querySelector(".fd-foot"));
      BS.onStore(["bs_up_tags", "bs_up_tag_map"], async () => {
        await loadTags();
        render();
      });
    },
    unmount() {
      document.removeEventListener("keydown", onKey);
      viewing = null;
      io?.disconnect();
      io = null;
      root = null;
    }
  });
})();
