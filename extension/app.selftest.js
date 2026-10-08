// Run: /usr/local/bin/node extension/app.selftest.js
const assert = require("assert");
const { errText, nameOf } = require("./app.js");

assert.strictEqual(errText(Object.assign(new Error("B站返回 -101：账号未登录"), { code: -101 })), "B站 没登录，先在这个浏览器登录 B站");
assert.strictEqual(errText("拉我的关注失败：B站返回 -101：账号未登录"), "拉我的关注失败：B站 没登录，先在这个浏览器登录 B站", "stored job text keeps its prefix");
assert.strictEqual(errText("B站返回 -352：风控校验失败"), "被 B站 限流，过一阵再试");
assert.strictEqual(errText(Object.assign(new Error("x"), { code: 22115 })), "对方隐藏了关注列表");
assert.strictEqual(errText("B站返回 -404：啥都木有"), "账号不存在或已注销");
assert.strictEqual(errText("取关失败：B站返回 22999：xx"), "取关失败：B站 返回错误（代码 22999）", "unknown code");
assert.strictEqual(errText("B站请求失败 HTTP 412"), "被 B站 限流，过一阵再试");
assert.strictEqual(errText(Object.assign(new Error("被 B站 限流，已暂停"), { code: "THROTTLED" })), "被 B站 限流，过一阵再试");
assert.strictEqual(errText(new Error("还没设置 AI")), "还没设置 AI", "no code: message as is");
assert.strictEqual(errText(Object.assign(new Error("AI 没回"), { code: "NO_AI" })), "AI 没回", "unknown text code: message as is");

assert.deepStrictEqual(nameOf({ name: "测试UP" }, "1"), { name: "测试UP", missing: false, gone: false });
assert.deepStrictEqual(nameOf(undefined, "123"), { name: "未获取名字", missing: true, gone: false });
assert.deepStrictEqual(nameOf({ name: "123" }, "123"), { name: "未获取名字", missing: true, gone: false }, "the mid is not a name");
assert.deepStrictEqual(nameOf({ name: "老名字", gone: true }, "5"), { name: "老名字", missing: false, gone: true });
console.log("app selftest ok");
