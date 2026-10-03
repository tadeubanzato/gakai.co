// One live-event connection per browser tab, however many accounts and views want events.
//
// A browser allows only a handful of simultaneous connections to one host (six over plain
// HTTP/1.1), and each open tab used to spend one per account plus one for the open account. Three
// tabs were enough to leave no connection for loading the page at all. Now:
//   • every subscriber shares a single stream covering the union of the accounts they follow;
//   • a hidden tab holds no connection, and says so to subscribers when it comes back (`onResume`)
//     so they can catch up on whatever they missed.
export function createEventHub({ open = url => new EventSource(url), doc = document } = {}) {
  const subscribers = new Set();
  let source = null, openKey = '';

  const wanted = () => [...new Set([...subscribers].flatMap(subscriber => [...subscriber.ids]))].sort();
  const dispatch = event => {
    let change;
    try { change = JSON.parse(event.data); } catch { return; }
    const accountId = change?.account?.id;
    for (const subscriber of [...subscribers]) if (subscriber.ids.has(accountId)) subscriber.handler(event, change);
  };
  const close = () => { if (source) { source.removeEventListener('gakai', dispatch); source.close(); source = null; } openKey = ''; };
  const sync = () => {
    const ids = wanted();
    const next = doc.visibilityState === 'hidden' ? '' : ids.join(',');
    if (next === openKey) return;
    close();
    if (!next) return;
    openKey = next;
    // after=now: callers already hold the current state from a normal fetch; a reconnect by the
    // browser itself still catches up through Last-Event-ID.
    source = open(`/api/app/events?accountId=${encodeURIComponent(next)}&after=now`);
    source.addEventListener('gakai', dispatch);
  };
  doc.addEventListener('visibilitychange', () => {
    const resuming = !source && doc.visibilityState !== 'hidden';
    sync();
    if (resuming) for (const subscriber of [...subscribers]) subscriber.onResume?.();
  });

  return {
    subscribe(ids, handler, onResume) {
      const subscriber = { ids: new Set(ids), handler, onResume };
      subscribers.add(subscriber);
      sync();
      return () => { subscribers.delete(subscriber); sync(); };
    },
    get connected() { return Boolean(source); },
  };
}
