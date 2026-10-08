// chrome.storage.local helpers for the DESIGN.md keys. Defines globalThis.Store.
// Read-modify-write calls on the same key are serialized within this context so concurrent jobs do not lose updates.
(() => {
  const area = () => chrome.storage.local;
  const locks = new Map();
  function locked(key, fn) {
    const run = (locks.get(key) || Promise.resolve()).then(fn);
    locks.set(key, run.catch(() => {}));
    return run;
  }

  const Store = {
    async get(key, fallback) {
      const got = await area().get(key);
      return got[key] === undefined ? fallback : got[key];
    },
    set(key, value) {
      return locked(key, () => area().set({ [key]: value }));
    },
    // Locked read-modify-write of a map: fn(current map) returns the new map.
    update(key, fn) {
      return locked(key, async () => {
        const next = fn((await area().get(key))[key] || {});
        await area().set({ [key]: next });
        return next;
      });
    },
    // Shallow-merge `entries` into the map stored at `key` (bs_people, bs_circle, bs_content ...).
    patch(key, entries) {
      return Store.update(key, (cur) => Object.assign(cur, entries));
    },
    // Merge `fields` into map[id] (bs_jobs[job]).
    async patchIn(key, id, fields) {
      return (await Store.update(key, (cur) => ({ ...cur, [id]: { ...cur[id], ...fields } })))[id];
    },
    remove(key) {
      return locked(key, () => area().remove(key));
    }
  };

  globalThis.Store = Store;
})();
