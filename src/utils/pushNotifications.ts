import { supabase } from '../lib/supabase';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

let reloadingForUpdate = false;

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    console.log('Service workers not supported');
    return null;
  }
  try {
    // When a NEW service worker takes control (e.g. after a deploy that ships
    // an updated sw.js), reload once so the page runs the fresh build instead
    // of a stale cached shell. Guards:
    //   - `hadController` skips the reload on a first-ever install (there was
    //     no prior worker, so nothing to refresh away from).
    //   - `reloadingForUpdate` prevents reload loops within a page load.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloadingForUpdate) return;
      reloadingForUpdate = true;
      window.location.reload();
    });

    const registration = await navigator.serviceWorker.register('/sw.js');
    console.log('Service Worker registered');

    // Proactively check for a newer sw.js now and once an hour, so a long-lived
    // POS tab picks up a new worker (and its cache purge) without anyone having
    // to manually clear site data.
    void registration.update();
    setInterval(() => { void registration.update(); }, 60 * 60 * 1000);

    return registration;
  } catch (err) {
    console.error('Service Worker registration failed:', err);
    return null;
  }
}

export function getPermissionState(): NotificationPermission {
  if (!('Notification' in window)) return 'denied';
  return Notification.permission;
}

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function subscribeForPush(
  manicuristId: string
): Promise<{ ok: boolean; error?: string }> {
  if (!isPushSupported()) {
    return { ok: false, error: 'Push notifications are not supported on this browser.' };
  }
  if (!VAPID_PUBLIC_KEY) {
    return { ok: false, error: 'VITE_VAPID_PUBLIC_KEY is not configured.' };
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return { ok: false, error: `Permission ${permission}` };
    }

    const registration =
      (await navigator.serviceWorker.getRegistration()) ||
      (await navigator.serviceWorker.register('/sw.js'));
    await navigator.serviceWorker.ready;

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const json = subscription.toJSON();
    const endpoint = json.endpoint || subscription.endpoint;
    const p256dh =
      json.keys?.p256dh ||
      arrayBufferToBase64Url(subscription.getKey('p256dh'));
    const auth =
      json.keys?.auth ||
      arrayBufferToBase64Url(subscription.getKey('auth'));

    if (!endpoint || !p256dh || !auth) {
      return { ok: false, error: 'Subscription missing endpoint or keys' };
    }

    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        { manicurist_id: manicuristId, endpoint, p256dh, auth },
        { onConflict: 'manicurist_id,endpoint' }
      );

    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function unsubscribeFromPush(): Promise<{ ok: boolean; error?: string }> {
  if (!isPushSupported()) return { ok: true };
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return { ok: true };
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return { ok: true };
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    const { error } = await supabase
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', endpoint);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function isDeviceSubscribed(): Promise<boolean> {
  if (!isPushSupported()) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return false;
  const sub = await registration.pushManager.getSubscription();
  return !!sub;
}

export async function getSubscribedManicuristIds(): Promise<Set<string>> {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/push_subscriptions?select=manicurist_id`,
      {
        headers: {
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'apikey': SUPABASE_ANON_KEY,
        },
      }
    );
    if (!response.ok) return new Set();
    const rows = await response.json() as { manicurist_id: string }[];
    return new Set(rows.map((r) => r.manicurist_id));
  } catch {
    return new Set();
  }
}

export async function sendPushNotification(
  manicuristId: string,
  manicuristName: string,
  clientName: string,
  service: string,
  customBody?: string
): Promise<{ success: boolean; error?: string; debug?: string }> {
  try {
    const title = 'TurnEM - Aqua Team';
    const defaultBody = `Hi ${manicuristName}, it's your turn! Client: ${clientName} | Service: ${service}. Please head to your station.`;
    // Substitute {name}, {client}, {service} placeholders in the custom body so
    // staff can write templates in any language. Case-insensitive match.
    const fillPlaceholders = (tpl: string): string =>
      tpl
        .replace(/\{name\}/gi, manicuristName)
        .replace(/\{client\}/gi, clientName)
        .replace(/\{service\}/gi, service);
    const body = customBody && customBody.trim()
      ? fillPlaceholders(customBody.trim())
      : defaultBody;
    const response = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        manicuristId,
        title,
        body,
      }),
    });

    const data = await response.json();
    console.log('[push-debug] Full response:', JSON.stringify(data));
    if (!response.ok) {
      return { success: false, error: data.error || 'Push notification failed' };
    }
    const debugInfo = {
      ...(data.results?.[0] || {}),
      serverVapidPrefix: data.debug?.vapidPublicKeyPrefix,
    };
    return { success: true, debug: JSON.stringify(debugInfo) };
  } catch {
    return { success: false, error: 'Network error sending push notification' };
  }
}

// ─── Owner alerts ─────────────────────────────────────────────────────────
//
// The nightly reconciliation report and the shift-close sales summary are sent
// to a SYNTHETIC push id rather than a manicurists row, so the owner never
// appears on the board or in the turn rotation. Server side, the recipients
// live in public.report_push_recipients.
//
// These deliberately do NOT reuse unsubscribeFromPush(): that revokes the
// browser subscription and deletes every row for the endpoint, which would
// also silence the staff service alerts of whoever is logged in on the same
// device. Owner alerts are one extra row against the same endpoint, added and
// removed on their own.
export const OWNER_PUSH_ID = 'owner-tony';

/** Is this device receiving owner alerts? */
export async function isOwnerAlertsOn(): Promise<boolean> {
  if (!isPushSupported()) return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return false;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return false;
    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('manicurist_id')
      .eq('endpoint', subscription.endpoint)
      .eq('manicurist_id', OWNER_PUSH_ID)
      .maybeSingle();
    if (error) return false;
    return !!data;
  } catch {
    return false;
  }
}

/** Start sending owner alerts to this device. */
export async function enableOwnerAlerts(): Promise<{ ok: boolean; error?: string }> {
  return subscribeForPush(OWNER_PUSH_ID);
}

/**
 * Stop owner alerts on this device WITHOUT touching the browser subscription,
 * so any staff alerts bound to the same endpoint keep working.
 */
export async function disableOwnerAlerts(): Promise<{ ok: boolean; error?: string }> {
  if (!isPushSupported()) return { ok: true };
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return { ok: true };
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return { ok: true };
    const { error } = await supabase
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', subscription.endpoint)
      .eq('manicurist_id', OWNER_PUSH_ID);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Send one owner-level notification to every active recipient in
 * report_push_recipients. Fire-and-forget: never throws, and the caller is not
 * expected to await it before doing anything that matters.
 */
export async function pushToOwners(title: string, body: string): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('report_push_recipients')
      .select('push_id')
      .eq('active', true);
    if (error || !data?.length) return 0;

    let sent = 0;
    for (const row of data as { push_id: string }[]) {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ manicuristId: row.push_id, title, body }),
        });
        if (res.ok) sent++;
      } catch {
        // one bad recipient must not stop the rest
      }
    }
    return sent;
  } catch {
    return 0;
  }
}
