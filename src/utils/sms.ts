const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export async function sendTurnAlert(
  phone: string,
  manicuristName: string,
  clientName: string,
  service: string
): Promise<{ success: boolean; error?: string }> {
  if (!phone) {
    return { success: false, error: 'No phone number on file' };
  }

  const message = `Hi ${manicuristName}, it's your turn! Client: ${clientName} | Service: ${service}. Please head to your station. - Aqua Team`;

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: phone, message }),
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || 'SMS send failed' };
    }

    return { success: true };
  } catch {
    return { success: false, error: 'Network error sending SMS' };
  }
}
