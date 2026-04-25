const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

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
