export function createPresence({ changed = () => {}, now = Date.now, leaseMs = 6000 } = {}) {
  const seen = new Map(), online = new Set();
  function update(id, connected) {
    if (online.has(id) === connected) return;
    if (connected) online.add(id); else online.delete(id);
    changed();
  }
  const timer = setInterval(() => { for (const [id, time] of seen) if (now() - time >= leaseMs) update(id, false); }, 1000);
  timer.unref();
  return {
    touch(id) { seen.set(id, now()); update(id, true); },
    disconnect(id) { seen.delete(id); update(id, false); },
    connected(id) { return online.has(id) && now() - seen.get(id) < leaseMs; },
    close() { clearInterval(timer); seen.clear(); online.clear(); }
  };
}
