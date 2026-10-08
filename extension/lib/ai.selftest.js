// Run: /usr/local/bin/node extension/lib/ai.selftest.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = { AbortSignal, JSON, console };
ctx.globalThis = ctx;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "ai.js"), "utf8"), ctx);
const Ai = ctx.Ai;
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---- upItem + prompt ----
const tags = [{ id: "t1", name: "AI", rule: " 讲大模型\n的 " }, { id: "t2", name: "游戏", rule: "" }];
const people = { 1: { name: "甲|乙", sign: "签名\n第二行" }, 2: { name: "丙" } };
const content = { 1: { tlist: { 知识: 3, 科技: 9 }, v: [1, 2, 3, 4, 5, 6].map((n) => ({ t: `标题${n}` })) } };
const it1 = Ai.upItem("1", people, content, tags, { 1: ["t2", "gone"] });
assert.deepStrictEqual(plain(it1), { mid: "1", name: "甲|乙", sign: "签名\n第二行", zone: "科技", titles: ["标题1", "标题2", "标题3", "标题4", "标题5"], currentTags: ["游戏"] });
assert.strictEqual(Ai.upLine(it1, 1), "1|甲 乙|签名 第二行|科技|标题1；标题2；标题3；标题4；标题5|游戏");
const it2 = Ai.upItem("2", people, content, tags, {});
assert.strictEqual(Ai.upLine(it2, 2), "2|丙||||");

const msgs = Ai.buildMessages({ instruction: " 把讲 AI 的标上 ", tags, items: [it1, it2] });
assert.ok(msgs[0].content.includes("AI：讲大模型 的\n游戏"), "tag lines with rules");
assert.ok(msgs[0].content.includes("至多 5 个"));
assert.ok(msgs[1].content.includes("<<<指令>>>\n把讲 AI 的标上\n<<<指令结束>>>"));
assert.ok(msgs[1].content.endsWith("1|甲 乙|签名 第二行|科技|标题1；标题2；标题3；标题4；标题5|游戏\n2|丙||||"));
assert.ok(msgs[0].content.includes("remove 一律留空"), "add-only by default");
assert.ok(!msgs[0].content.includes("remove 只能填"));
assert.ok(Ai.buildMessages({ instruction: "x", tags, items: [], allowRemove: true })[0].content.includes("remove 只能填该 UP 主"));
assert.ok(Ai.buildMessages({ instruction: "x", tags: [], items: [], maxNewTags: 0 })[0].content.includes("这次不能新建标签"));
assert.ok(Ai.buildMessages({ instruction: "x", tags: [], items: [] })[0].content.endsWith("：\n（无）"));

// ---- parse ----
const items = [it1, it2];
const out = '```json\n{"new_tags":["科普","新1","新2","新3","新4","新5","科普"],"items":[' +
  '{"i":1,"add":["AI","不存在","游戏","科普"],"remove":["游戏","AI"],"reason":"讲模型 {x}"},' +
  '{"i":2,"add":["新1"],"reason":"r2"},{"i":2,"add":["AI"]},{"i":9,"add":["AI"]}],"note":"做完了"}\n```';
assert.deepStrictEqual(plain(Ai.parse(out, items, tags, { allowRemove: true })), {
  newTags: ["科普", "新1"], // cap 5 counts first; unused 新2..新4 dropped
  assignments: {
    1: { add: ["AI", "科普"], remove: ["游戏"], reason: "讲模型 {x}" },
    2: { add: ["新1"], remove: [], reason: "r2" }
  },
  note: "做完了"
});
// Default is add-only: removes are dropped, an UP with only removes is left out.
assert.deepStrictEqual(plain(Ai.parse(out, items, tags)).assignments[1].remove, []);
assert.deepStrictEqual(plain(Ai.parse('{"items":[{"i":1,"remove":["游戏"]}]}', items, tags)).assignments, {});
// new-tag cap 0: only existing tags.
assert.deepStrictEqual(plain(Ai.parse(out, items, tags, { maxNewTags: 0, allowRemove: true })).assignments, { 1: { add: ["AI"], remove: ["游戏"], reason: "讲模型 {x}" } });
// cap 1 keeps the first new tag only.
assert.deepStrictEqual(plain(Ai.parse(out, items, tags, { maxNewTags: 1 })).newTags, ["科普"]);
// cap setting: 0..50, missing = 5; an existing tag stays usable whatever the cap.
assert.deepStrictEqual([undefined, "", "x", -3, 0, 2.6, 99].map(Ai.newTagCap), [5, 5, 5, 0, 0, 3, 50]);
// thinking switch per provider (MoonDigest #108)
for (const u of ["https://api.deepseek.com/v1", "https://open.bigmodel.cn/api/paas/v4", "https://api.z.ai/api/paas/v4", "https://api.moonshot.cn/v1", "https://api.moonshot.ai/v1"]) assert.ok(Ai.thinkingToggle(u), u);
for (const u of ["https://api.openai.com/v1", "http://localhost:11434/v1", "https://api.deepseek.com.evil.test/v1", ""]) assert.ok(!Ai.thinkingToggle(u), u);
// bad JSON
assert.throws(() => Ai.parse("没有 JSON", items, tags), /格式不对/);
assert.throws(() => Ai.parse('{"items":[', items, tags), /不完整/);
assert.throws(() => Ai.parse("{items: 1}", items, tags), /格式不对/);
assert.deepStrictEqual(plain(Ai.parse('{"items":"x"}', items, tags)), { newTags: [], assignments: {}, note: "" });

// ---- tag(): batches of 60, new tags carried across batches ----
(async () => {
  const mids = Array.from({ length: 130 }, (_, i) => String(i + 1));
  const calls = [];
  ctx.chrome = { storage: { local: { get: async () => ({ bs_settings: { ai: { baseUrl: "https://ai.test/v1/", model: "m", apiKey: "k" } }, bs_up_tags: tags, bs_up_tag_map: {} }) } } };
  ctx.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization, body });
    const n = calls.length;
    const reply = n === 1
      ? { new_tags: ["科普"], items: [{ i: 1, add: ["科普"] }], note: "一" }
      : { new_tags: ["科普", "新"], items: [{ i: 1, add: ["科普", "新"] }], note: n === 2 ? "二" : "" };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) };
  };
  const r = plain(await Ai.tag({ instruction: "分一下", mids }));
  assert.strictEqual(calls[0].body.thinking, undefined, "ai.test gets no thinking param");
  assert.strictEqual(calls.length, 3, "130 UPs -> 3 calls");
  assert.strictEqual(calls[0].url, "https://ai.test/v1/chat/completions");
  assert.strictEqual(calls[0].auth, "Bearer k");
  assert.strictEqual(calls[2].body.messages[1].content.split("\n").filter((l) => /^\d+\|/.test(l)).length, 10);
  assert.ok(calls[1].body.messages[0].content.includes("\n科普"), "batch 2 sees 科普 as existing");
  assert.ok(calls[1].body.messages[0].content.includes("至多 4 个"));
  assert.deepStrictEqual(r.newTags, ["科普", "新"]);
  assert.deepStrictEqual(r.assignments["1"].add, ["科普"]);
  assert.deepStrictEqual(r.assignments["61"].add, ["科普", "新"]);
  assert.deepStrictEqual(r.assignments["121"].add, ["科普", "新"]);
  assert.strictEqual(r.note, "一 二");

  // aiNewTags 1 + aiRemove on, DeepSeek URL: thinking off, cap carried, removes kept.
  calls.length = 0;
  ctx.chrome.storage.local.get = async () => ({ bs_settings: { ai: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash" }, aiNewTags: 1, aiRemove: true }, bs_up_tags: tags, bs_up_tag_map: { 1: ["t2"] } });
  ctx.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"new_tags":["甲","乙"],"items":[{"i":1,"add":["甲","乙"],"remove":["游戏"]}]}' } }] }) };
  };
  const r2 = plain(await Ai.tag({ instruction: "x", mids: ["1"] }));
  assert.deepStrictEqual(calls[0].thinking, { type: "disabled" });
  assert.ok(calls[0].messages[0].content.includes("至多 1 个") && calls[0].messages[0].content.includes("remove 只能填"));
  assert.deepStrictEqual(r2.assignments["1"], { add: ["甲"], remove: ["游戏"], reason: "" });

  // Truncation: finish_reason length says 截断, not 格式不对; empty content says so; the 1-token test still passes.
  const reply = (choice) => async () => ({ ok: true, json: async () => ({ choices: [choice] }) });
  ctx.fetch = reply({ finish_reason: "length", message: { content: '{"items":[{"i":1,' } });
  await assert.rejects(Ai.tag({ instruction: "x", mids: ["1"] }), (e) => e.code === "AI_CUT" && /被截断了.*少选几个/.test(e.message));
  ctx.fetch = reply({ finish_reason: "length", message: { content: "" } });
  await assert.rejects(Ai.chat({ baseUrl: "https://a.test", model: "m" }, []), /被截断了/);
  assert.strictEqual(await Ai.test({ baseUrl: "https://a.test", model: "m" }), "ok");
  ctx.fetch = reply({ finish_reason: "stop", message: { content: "  " } });
  await assert.rejects(Ai.chat({ baseUrl: "https://a.test", model: "m" }, []), /回复是空的/);

  ctx.fetch = async () => ({ ok: false, status: 401, text: async () => "bad key" });
  await assert.rejects(Ai.test({ baseUrl: "https://ai.test", model: "m" }), /HTTP 401：bad key/);
  await assert.rejects(Ai.test({ baseUrl: "", model: "m" }), /接口地址/);
  await assert.rejects(Ai.tag({ instruction: " ", mids }), /先写/);
  console.log("ai selftest ok");
})().catch((e) => { console.error(e); process.exit(1); });
