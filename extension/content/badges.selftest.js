// Run: /usr/local/bin/node extension/content/badges.selftest.js
// Pure parts of badges.js on a tiny DOM shim: author link -> mid, tags of a mid, and where the chip lands.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = {};
ctx.globalThis = ctx;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "badges.js"), "utf8"), ctx);
const { midFromHref, tagsOf, spotIn } = ctx.BsBadges;

// ---- mid parsing: bare profile links only ----
assert.strictEqual(midFromHref("//space.bilibili.com/123456789"), "123456789");
assert.strictEqual(midFromHref("https://space.bilibili.com/123456789/?spm_id_from=333.788.upinfo.detail.click"), "123456789");
assert.strictEqual(midFromHref("//space.bilibili.com/987654321?spm_id_from=333.1387"), "987654321");
assert.strictEqual(midFromHref("//space.bilibili.com/1234567#/album"), "1234567");
assert.strictEqual(midFromHref("//space.bilibili.com/7654321/favlist"), "");
assert.strictEqual(midFromHref("https://space.bilibili.com/7654321/fans/follow"), "");
assert.strictEqual(midFromHref("//space.bilibili.com/111222333/video"), "");
assert.strictEqual(midFromHref("https://www.bilibili.com/video/BV1xx411c7mD"), "");
assert.strictEqual(midFromHref(null), "");

// ---- tags of a mid keep bs_up_tags order ----
const tags = [{ id: "a", name: "常看" }, { id: "b", name: "游戏" }, { id: "c", name: "学习" }];
assert.deepStrictEqual(tagsOf("1", tags, { 1: ["c", "a", "gone"] }).map((t) => t.id), ["a", "c"]);
assert.strictEqual(tagsOf("2", tags, { 1: ["a"] }).length, 0);
assert.strictEqual(tagsOf("1", tags, undefined).length, 0);

// ---- tiny DOM: h("a", {}, h("span", {}, "name")) ----
const text = (data) => ({ nodeType: 3, data });
function h(tagName, ...kids) {
  const el = { nodeType: 1, tagName: tagName.toUpperCase(), childNodes: [] };
  for (const k of kids) {
    const n = typeof k === "string" ? text(k) : k;
    n.parentNode = el;
    el.childNodes.push(n);
  }
  return el;
}

// Home / search video card: <a owner><svg/><span author>UP</span><span date>· 3-12</span></a> -> after the author span.
const author = h("span", "华师沈威");
const homeCard = h("a", h("svg", h("path")), author, h("span", "· 3-12"));
assert.strictEqual(spotIn(homeCard), author);

// Video page / search user / BewlyCat channel name: <a>\n name <span mask/></a> -> right after the name text.
const upName = h("a", "\n      华师沈威\n      ", h("span"));
assert.strictEqual(spotIn(upName), upName.childNodes[0]);

// Recommend list: <a><svg>..</svg><span name>UP</span></a>; svg text is skipped.
const rec = h("a", h("svg", "icon"), h("span", h("b", "UP 名")));
assert.strictEqual(spotIn(rec).tagName, "B");

// Avatar links have no text: no chip.
assert.strictEqual(spotIn(h("a", h("div", h("img"), "  "))), null);

// ---- live copies on one fake page: chips say where they come from, a fresh copy replaces an old one, and a copy whose
// extension context is gone stops instead of throwing ----
(async () => {
  const chips = [];
  const el = (tagName) => ({
    tagName, dataset: {}, style: { setProperty() {} }, setAttribute() {}, kids: [], isConnected: false,
    append(...k) { this.kids.push(...k); },
    remove() { this.isConnected = false; }
  });
  const doc = new EventTarget();
  const link = { nodeType: 1, tagName: "A", getAttribute: () => "//space.bilibili.com/42" };
  const name = { nodeType: 3, data: "UP", parentNode: link, getRootNode: () => doc, after(c) { c.isConnected = true; c.previousSibling = name; chips.push(c); } };
  link.childNodes = [name];
  Object.assign(doc, {
    documentElement: {}, head: { append() {} }, getElementById: () => null, createElement: el,
    querySelectorAll: (sel) => (sel === ".bsc-tags" ? chips.filter((c) => c.isConnected) : sel.startsWith("a[") ? [link] : [])
  });
  const store = { bs_up_tags: [{ id: "t1", name: "常看", color: "#f00" }], bs_up_tag_map: { 42: ["t1"] } };
  function copy() {
    const sent = [];
    const observers = [];
    const chrome = {
      storage: { local: { get: async (k) => Object.fromEntries([].concat(k).map((x) => [x, store[x]])) }, onChanged: { addListener() {}, removeListener() {} } },
      runtime: { id: "ext", sendMessage: async (m) => sent.push(m) }
    };
    class MutationObserver { constructor() { this.on = false; observers.push(this); } observe() { this.on = true; } disconnect() { this.on = false; } }
    const c = { chrome, document: doc, Event, MutationObserver, setTimeout, clearTimeout, location: { hostname: "www.bilibili.com", pathname: "/" } };
    c.globalThis = c;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "badges.js"), "utf8"), c);
    return { chrome, sent, observing: () => observers.some((o) => o.on) };
  }
  const settle = () => new Promise((r) => setTimeout(r, 450));
  const click = (target) => {
    const e = new Event("click", { cancelable: true });
    e.composedPath = () => [target];
    doc.dispatchEvent(e);
    return e;
  };

  const a = copy();
  await settle();
  const chipA = chips.find((c) => c.isConnected);
  assert.ok(chipA, "a tagged UP gets chips");
  assert.match(chipA.title, /^B站社交圈的标签 · 只存在扩展里/);
  assert.match(fs.readFileSync(path.join(__dirname, "badges.js"), "utf8"), /\.bsc-tags \{[^}]*border-left: 2px solid/, "chips carry a left marker");
  chipA.kids[0].classList = { contains: (c) => c === "bsc-chip" };
  assert.strictEqual(click(chipA.kids[0]).defaultPrevented, true);
  assert.strictEqual(a.sent.length, 1);

  // Extension reloaded: the background injects a fresh copy; the old one removes its chips and stops listening.
  const b = copy();
  assert.strictEqual(chipA.isConnected, false, "old chips removed");
  assert.strictEqual(a.observing(), false, "old observer stopped");
  await settle();
  const chipB = chips.find((c) => c.isConnected);
  chipB.kids[0].classList = { contains: (c) => c === "bsc-chip" };
  click(chipB.kids[0]);
  assert.deepStrictEqual([a.sent.length, b.sent.length], [1, 1], "only the fresh copy handles clicks");

  // A copy whose context is gone (chrome.runtime.id undefined) lets the click through and stands down.
  delete b.chrome.runtime.id;
  b.chrome.runtime.sendMessage = () => { throw new Error("Extension context invalidated."); };
  const e = click(chipB.kids[0]);
  assert.strictEqual(e.defaultPrevented, false);
  assert.strictEqual(b.observing(), false);
  assert.strictEqual(chipB.isConnected, false);
  console.log("badges selftest ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
