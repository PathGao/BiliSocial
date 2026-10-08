// Run: /usr/local/bin/node extension/pages/follow.selftest.js
const assert = require("assert");
const { followStatus } = require("./follow.js");

const now = 1_800_000_000;
const ago = (days) => ({ code: 0, count: 1, v: [{ c: now - days * 86400 }, { c: now - 999 * 86400 }] });
assert.strictEqual(followStatus(undefined, now), "unchecked");
assert.strictEqual(followStatus({ code: -404 }, now), "unchecked");
assert.strictEqual(followStatus({ code: 0, count: 0, v: [] }, now), "none");
assert.strictEqual(followStatus(ago(10), now), "active");
assert.strictEqual(followStatus(ago(89), now), "active");
assert.strictEqual(followStatus(ago(90), now), "slow");
assert.strictEqual(followStatus(ago(364), now), "slow");
assert.strictEqual(followStatus(ago(365), now), "dead");
assert.strictEqual(followStatus(ago(20), now, 14, 30), "slow", "custom thresholds");
assert.strictEqual(followStatus({ code: 0, v: [{ c: now - 999 * 86400 }, { c: now - 86400 }] }, now), "active", "newest of the list, not the first");
// Feed fallback (bs_last_post) when bs_content has nothing yet
const lp = { since: now - 95 * 86400, map: { 7: now - 3 * 86400, 8: now - 92 * 86400 } };
assert.strictEqual(followStatus(undefined, now, 90, 365, lp, "7"), "active", "seen in the feed");
assert.strictEqual(followStatus(undefined, now, 90, 365, lp, "8"), "slow", "seen in the feed, old post");
assert.strictEqual(followStatus(undefined, now, 90, 365, lp, "9"), "stale", "feed reaches past slowDays, not seen");
assert.strictEqual(followStatus(undefined, now, 90, 365, { since: now - 10 * 86400, map: {} }, "9"), "unchecked", "feed too short to tell");
assert.strictEqual(followStatus(ago(400), now, 90, 365, lp, "7"), "active", "a newer post in the feed beats older fetched videos");
assert.strictEqual(followStatus(ago(400), now, 90, 365, lp, "9"), "dead", "fetched videos when the feed has nothing newer");
assert.strictEqual(followStatus({ code: 0, count: 0, v: [] }, now, 90, 365, lp, "9"), "none");
console.log("follow selftest ok");
