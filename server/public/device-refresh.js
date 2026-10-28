// One refresh at a time; retain the last successful device list during outages.
export function createDeviceRefresh({ load, apply, state }) {
  let pending = null, failures = 0, generation = 0;
  return {
    refresh() {
      if (pending) return pending;
      const current = generation;
      state({ status: 'refreshing' });
      const request = Promise.resolve().then(load).then(devices => {
        if (generation !== current) return;
        failures = 0; apply(devices); state({ status: 'connected' });
      }).catch(error => {
        if (generation === current) { failures++; state({ status: 'retrying', error: error.message }); }
        throw error;
      }).finally(() => { if (pending === request) pending = null; });
      pending = request;
      return request;
    },
    invalidate() { generation++; pending = null; },
    nextDelay() { return Math.min(30_000, 5000 * 2 ** Math.min(failures, 3)); }
  };
}
