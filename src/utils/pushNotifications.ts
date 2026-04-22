const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const VAPID_PUBLIC_KEY = 'BN-K9bkKqYnH7ZmCXZEeK55L1TnxlYO0ofQpL5sIsNZYftFq9TcuQ540eoAdHkUPLKAcFgqIs4IDlLT-xPoqdHo';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

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

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function getPermissionState(): NotificationPermission {
  if (!('Notification' in window)) return 'denied';
  return Notification.permission;
}

export async function subscribeToPush(manicuristId: string): Promise<{ success: boolean; error?: string }> {
  if (!isPushSupported()) {
    return { success: false, error: 'Push notifications not supported on this browser' };
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return { success: false, error: 'Notification permission denied' };
    }

    const registration = await navigator.serviceWorker.ready;

    // Check for existing subscription
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const subJson = subscription.toJSON();

    // Save to Supabase
    const response = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        manicurist_id: manicuristId,
        endpoint: subJson.endpoint,
        p256dh: subJson.keys?.p256dh,
        auth: subJson.keys?.auth,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return { success: false, error: `Failed to save subscription: ${err}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function unsubscribeFromPush(manicuristId: string): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await subscription.unsubscribe();
    }
    // Remove from DB
    await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?manicurist_id=eq.${manicuristId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      },
    });
  } catch (err) {
    console.error('Unsubscribe failed:', err);
  }
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
  service: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        manicuristId,
        title: 'TurnEM - Aqua Team',
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
