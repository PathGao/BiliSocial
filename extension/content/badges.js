// Content script on B站 pages: the user's UP tags (bs_up_tags / bs_up_tag_map) as small chips after an author's name.
// Authors are found by links to space.bilibili.com/<mid>, plus two name-only spots: the 动态 page's card titles (matched
// by name against bs_people) and a space page's own nickname (mid from the URL). UPs without tags get zero DOM changes.
// A chip click opens app.html#feed?tag=<id>. Approach follows MoonDigest's badges.js (BewlyCat shadow root, debounced
// MutationObserver). Styles live here, not in a manifest css file, because BewlyCat's shadow root needs its own copy;
// chip text mixes the tag color with B站's (or BewlyCat's) own text variable, so it follows their dark mode.
// After an extension reload or update the background injects a fresh copy into open tabs (MoonDigest #31): the fresh
// copy fires "bsc-superseded" first and the old one removes its chips and listeners. An old copy whose chrome.runtime
// is gone (context invalidated) also stops by itself instead of throwing on a click.
(() => {
  // Only a bare profile link counts: /favlist, /video, /fans/follow are menu links, not author names.
  const MID_RE = /(?:^|\/\/)space\.bilibili\.com\/(\d+)\/?(?:[?#]|$)/;
  const midFromHref = (href) => MID_RE.exec(String(href || ""))?.[1] || "";
  const MAX_CHIPS = 3;

  // [{ id, name, color }] for a mid, in bs_up_tags order.
  function tagsOf(mid, tags, map) {
    const ids = new Set(map?.[mid] || []);
    return ids.size ? (tags || []).filter((t) => ids.has(t.id)) : [];
  }

  // First text node with visible characters under `el`, depth first. Plain childNodes so selftests need no real DOM.
  function firstText(el) {
    for (const n of el.childNodes || []) {
      if (n.nodeType === 3 && n.data.trim()) return n;
      if (n.nodeType === 1 && !/^(svg|style|script)$/i.test(n.tagName)) {
        const t = firstText(n);
        if (t) return t;
      }
    }
    return null;
  }

  // Where the chip goes for an author link: right after the name. A name wrapped in its own element (home cards:
  // <span author>name</span><span date>) gets the chip after that element; a bare name gets it right after the text.
  // Returns the node to call .after(chip) on, or null for links without text (avatars).
  function spotIn(a) {
    const t = firstText(a);
    if (!t) return null;
    return t.parentNode === a ? t : t.parentNode;
  }

  globalThis.BsBadges = { midFromHref, tagsOf, firstText, spotIn };
  if (typeof chrome === "undefined" || !chrome.storage?.local || typeof document === "undefined") return;
  // Before any listener of ours exists, so only an older copy hears it.
  document.dispatchEvent(new Event("bsc-superseded"));

  const CSS = `
.bsc-tags { display: inline-flex; flex: none; gap: 3px; margin: 0 4px; padding-left: 4px; border-left: 2px solid color-mix(in srgb, var(--text3, var(--bew-text-3, #9499a0)) 60%, transparent); vertical-align: 1px; white-space: nowrap; line-height: 1; text-indent: 0; font-style: normal; text-decoration: none; }
.bsc-chip { display: inline-block; padding: 1px 5px; border: 1px solid color-mix(in srgb, var(--bsc-c) 60%, transparent); border-radius: 4px;
  background: color-mix(in srgb, var(--bsc-c) 14%, transparent); color: color-mix(in srgb, var(--bsc-c) 70%, var(--text1, var(--bew-text-1, #18191c)));
  font: 500 11px/14px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; cursor: pointer; }
.bsc-chip:hover, .bsc-chip:focus-visible { background: color-mix(in srgb, var(--bsc-c) 26%, transparent); outline: none; }`;
  const SEL = 'a[href*="space.bilibili.com/"]';
  // 动态 cards have no profile link on the name; the name is matched against bs_people instead.
  const NAME_SEL = ".bili-dyn-title__text, .dyn-orig-author__name";
  const OWNER_SEL = ".upinfo-detail__top .nickname, #h-name";

  let tags = [];
  let map = {};
  let byName = null; // name -> mid for tagged UPs, built on first need
  let enabled = false;
  let timer = 0;
  const owned = new WeakMap(); // spot element -> its chip
  const observer = new MutationObserver(() => schedule());
  const OBSERVE = { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] };

  const bewlyRoot = () => document.getElementById("bewly")?.shadowRoot || null;
  const findAll = (sel) => {
    const r = bewlyRoot();
    return [...document.querySelectorAll(sel), ...(r ? r.querySelectorAll(sel) : [])];
  };
  const pageOwner = () => (location.hostname === "space.bilibili.com" ? /^\/(\d+)/.exec(location.pathname)?.[1] || "" : "");

  const styled = new WeakSet();
  function addStyle(root) {
    if (styled.has(root)) return;
    styled.add(root);
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    } catch {
      const s = document.createElement("style");
      s.textContent = CSS;
      (root.head || root).append(s);
    }
  }
  let bewlyHooked = null;
  function hookBewly() {
    const r = bewlyRoot();
    if (!r || r === bewlyHooked) return;
    bewlyHooked = r;
    observer.observe(r, OBSERVE);
  }

  function chipEl(mid, list) {
    const box = document.createElement("span");
    box.className = "bsc-tags";
    box.dataset.key = `${mid}|${list.map((t) => `${t.id}:${t.name}:${t.color}`).join(",")}`;
    box.title = `B站社交圈的标签 · 只存在扩展里\n${list.map((t) => t.name).join("、")}（点标签看这个标签的动态）`;
    for (const t of list.slice(0, MAX_CHIPS)) {
      const c = document.createElement("span");
      c.className = "bsc-chip";
      c.dataset.tag = t.id;
      c.setAttribute("role", "link");
      c.tabIndex = 0;
      c.style.setProperty("--bsc-c", t.color || "#00aeec");
      c.textContent = t.name;
      box.append(c);
    }
    if (list.length > MAX_CHIPS) {
      const more = document.createElement("span");
      more.className = "bsc-chip";
      more.dataset.tag = list[MAX_CHIPS].id;
      more.style.setProperty("--bsc-c", "#9499a0");
      more.textContent = `+${list.length - MAX_CHIPS}`;
      box.append(more);
    }
    return box;
  }

  // Puts (or keeps, or removes) the chip of `mid` after `spot`, which is keyed by `key` (the link or name element).
  function mark(key, spot, mid) {
    const list = mid ? tagsOf(mid, tags, map) : [];
    const old = owned.get(key);
    const want = list.length ? chipEl(mid, list) : null;
    if (old?.isConnected && want && old.dataset.key === want.dataset.key && old.previousSibling === spot) return;
    old?.remove();
    owned.delete(key);
    if (!want || !spot) return;
    addStyle(spot.getRootNode());
    spot.after(want);
    owned.set(key, want);
  }

  async function names() {
    if (byName) return byName;
    const people = (await chrome.storage.local.get("bs_people")).bs_people || {};
    byName = new Map();
    for (const mid of Object.keys(map)) if (map[mid]?.length && people[mid]?.name) byName.set(people[mid].name, mid);
    return byName;
  }

  // ponytail: rescans at most every 400ms; the video page's danmaku layer mutates constantly and this caps that cost.
  function schedule() {
    if (!enabled || timer) return;
    if (!chrome.runtime?.id) return standDown();
    timer = setTimeout(() => {
      timer = 0;
      run().catch(() => {});
    }, 400);
  }

  async function run() {
    hookBewly();
    const owner = pageOwner();
    for (const a of findAll(SEL)) {
      const mid = midFromHref(a.getAttribute("href"));
      // On a space page the owner's own links (video cards) would all say the same thing; the nickname carries it.
      mark(a, mid && mid !== owner ? spotIn(a) : null, mid);
    }
    const nameEls = findAll(NAME_SEL);
    if (nameEls.length) {
      const m = await names();
      for (const el of nameEls) mark(el, el, m.get(el.textContent.trim()) || "");
    }
    if (owner) for (const el of findAll(OWNER_SEL)) mark(el, el, owner);
  }

  function clearAll() {
    findAll(".bsc-tags").forEach((n) => n.remove());
  }

  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    if (on) {
      observer.observe(document.documentElement, OBSERVE);
      schedule();
    } else {
      observer.disconnect();
      bewlyHooked = null;
      clearTimeout(timer);
      timer = 0;
      clearAll();
    }
  }

  async function load() {
    const got = await chrome.storage.local.get(["bs_up_tags", "bs_up_tag_map"]);
    tags = got.bs_up_tags || [];
    map = got.bs_up_tag_map || {};
    byName = null;
    if (dead) return;
    const on = tags.length > 0 && Object.values(map).some((ids) => ids?.length);
    if (on && enabled) schedule();
    setEnabled(on);
  }

  // Events from inside BewlyCat's shadow root reach the document retargeted to #bewly; composedPath has the real node.
  function onActivate(e) {
    if (e.type === "keydown" && e.key !== "Enter") return;
    const chip = e.composedPath?.().find((n) => n.classList?.contains("bsc-chip"));
    if (!chip) return;
    if (!chrome.runtime?.id) return standDown(); // extension reloaded: this copy is dead, let the click through
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: "bs-open-app", hash: `feed?tag=${encodeURIComponent(chip.dataset.tag)}` }).catch(() => {});
  }
  function onStorage(changes, area) {
    if (area === "local" && (changes.bs_up_tags || changes.bs_up_tag_map)) load().catch(() => {});
  }

  let dead = false;
  const CAP = { capture: true }; // an object, not `true`: node's EventTarget (selftest) only removes it that way
  function standDown() {
    if (dead) return;
    dead = true;
    setEnabled(false);
    document.removeEventListener("click", onActivate, CAP);
    document.removeEventListener("keydown", onActivate, CAP);
    document.removeEventListener("bsc-superseded", standDown);
    try { chrome.storage.onChanged.removeListener(onStorage); } catch {}
  }

  document.addEventListener("click", onActivate, CAP);
  document.addEventListener("keydown", onActivate, CAP);
  document.addEventListener("bsc-superseded", standDown);
  chrome.storage.onChanged.addListener(onStorage);
  load().catch(() => {});
})();
