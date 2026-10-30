// Auto-update for long-lived tabs (front desk POS, staff portal on phones).
//
// The service worker only forces a reload when sw.js itself changes, which an
// ordinary deploy never touches — so a tab left open all day kept running the
// old bundle until someone remembered to refresh (staff portal queue-position
// fix, 2026-10-30). Instead, poll the page's own HTML (served no-store by
// vercel.json) and compare its hashed entry script against the one this tab
// booted with. When they differ a new deploy is live; reload, but only at a
// moment that can't lose work.

const CHECK_INTERVAL_MS = 3 * 60 * 1000;
// No tap / key / scroll for this long counts as idle.
const IDLE_MS = 2 * 60 * 1000;

function entryScripts(doc: Document): string[] {
  return Array.from(doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))
    .map((s) => new URL(s.getAttribute('src') ?? '', location.origin).pathname)
    .sort();
}

// Is it safe to reload right now? Never while someone is typing or has a
// modal open (checkout ticket, assign, appointment…). Every modal in the app
// renders as a `fixed inset-0` overlay, so its presence is the signal.
function isSafeToReload(lastActivity: number): boolean {
  if (document.visibilityState === 'hidden') return true;
  if (Date.now() - lastActivity < IDLE_MS) return false;
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable)) {
    return false;
  }
  if (document.querySelector('.fixed.inset-0')) return false;
  return true;
}

export function startAutoUpdate(): void {
  if (import.meta.env.DEV) return;
  const booted = entryScripts(document).join('|');
  if (!booted) return;

  let lastActivity = Date.now();
  let updateReady = false;
  const touch = () => { lastActivity = Date.now(); };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
    window.addEventListener(ev, touch, { passive: true, capture: true });
  }

  const tryReload = () => {
    if (updateReady && isSafeToReload(lastActivity)) location.reload();
  };

  const check = async () => {
    if (updateReady) { tryReload(); return; }
    try {
      const res = await fetch(location.pathname, { cache: 'no-store' });
      if (!res.ok) return;
      const html = await res.text();
      const latest = entryScripts(new DOMParser().parseFromString(html, 'text/html')).join('|');
      if (latest && latest !== booted) {
        console.info('[turnem] new build available — will reload when idle', latest);
        updateReady = true;
        tryReload();
      }
    } catch {
      // Offline or a blip — try again next interval.
    }
  };

  setInterval(() => { void check(); }, CHECK_INTERVAL_MS);
  // Phone portal: reopening the app is the best moment to pick up a deploy.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
  // Once an update is pending, re-test the idle condition often so it lands
  // soon after the screen goes quiet rather than up to 3 minutes later.
  setInterval(tryReload, 15 * 1000);
}
