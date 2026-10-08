// Run: /usr/local/bin/node extension/lib/graph-ai.selftest.js
const assert = require("assert");
const A = require("./graph-ai.js");

const groups = [{ key: "a,b", zones: ["游戏"], members: [{ name: "甲", sign: "做游戏\n评测", titles: ["独立游戏推荐"] }] }, { key: "c,d", zones: [], members: [{ name: "乙" }] }];
const m = A.buildMessages(groups);
assert(m[1].content.includes("key: a,b") && m[1].content.includes("签名：做游戏 评测") && m[1].content.includes("独立游戏推荐"));
const names = A.parse('```json\n{"names":[{"key":"a,b","name":"「独立游戏圈子啊」","desc":"玩\\n独立游戏"},{"key":"zz","name":"多余"}]}\n```', ["a,b", "c,d"]);
assert.deepStrictEqual(names, [{ key: "a,b", name: "独立游戏圈子", desc: "玩 独立游戏" }], "unknown keys dropped, name cut to 6, one-line desc");
assert.throws(() => A.parse("不是 JSON", ["a,b"]), /格式不对/);
assert.throws(() => A.parse('{"names":[]}', ["a,b"]), /没给出名字/);
console.log("graph-ai selftest passed");
