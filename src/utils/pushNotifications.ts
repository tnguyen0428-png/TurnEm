import { supabase } from '../lib/supabase';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    console.log('Service workers not supported');
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    console.log('Service Worker registered');
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
  customTitle?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const title = customTitle && customTitle.trim() ? customTitle.trim() : 'TurnEM - Aqua Team';
    const response = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        manicuristId,
        title,
        body: `Hi ${manicuristName}, it's your turn! Client: ${clientName} | Service: ${service}. Please head to your station.`,
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
    return { success: true, error: JSON.stringify(debugInfo) };
  } catch {
    return { success: false, error: 'Network error sending push notification' };
  }
}
