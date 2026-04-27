import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
    const vapidEmail = Deno.env.get("VAPID_EMAIL") || "tnguyen0428@gmail.com";
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!vapidPublicKey || !vapidPrivateKey) {
      return new Response(
        JSON.stringify({ error: "VAPID keys not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    webpush.setVapidDetails(
      `mailto:${vapidEmail}`,
      vapidPublicKey,
      vapidPrivateKey
    );

    const { manicuristId, title, body: messageBody } = await req.json();

    if (!manicuristId || !messageBody) {
      return new Response(
        JSON.stringify({ error: "Missing manicuristId or body" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Fetch subscriptions for this manicurist
    const subResponse = await fetch(
      `${supabaseUrl}/rest/v1/push_subscriptions?manicurist_id=eq.${manicuristId}&select=*`,
      {
        headers: {
          Authorization: `Bearer ${supabaseServiceKey}`,
          apikey: supabaseServiceKey!,
        },
      }
    );

    const subscriptions = await subResponse.json();

    if (!subscriptions || subscriptions.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No push subscription found for this manicurist",
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const payload = JSON.stringify({ title, body: messageBody });
    const results: any[] = [];

    for (const sub of subscriptions) {
      try {
        const pushResult = await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload,
          {
            TTL: 86400,
            urgency: "high",
          }
        );

        results.push({
          endpoint: sub.endpoint,
          status: "sent",
          httpStatus: pushResult.statusCode,
          responseHeaders: pushResult.headers,
        });
      } catch (err: any) {
        const statusCode = err?.statusCode;

        if (statusCode === 410 || statusCode === 404) {
          await fetch(
            `${supabaseUrl}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`,
            {
              method: "DELETE",
              headers: {
                Authorization: `Bearer ${supabaseServiceKey}`,
                apikey: supabaseServiceKey!,
              },
            }
          );
          results.push({ endpoint: sub.endpoint, status: "expired_removed" });
        } else {
          results.push({
            endpoint: sub.endpoint,
            status: "error",
            httpStatus: statusCode,
            error: err?.body || String(err),
            headers: err?.headers,
          });
        }
      }
    }

    const anySuccess = results.some((r) => r.status === "sent");

    return new Response(
      JSON.stringify({
        success: anySuccess,
        results,
        debug: {
          vapidPublicKeyPrefix: vapidPublicKey.slice(0, 20),
          subscriptionCount: subscriptions.length,
          library: "npm:web-push@3.6.7",
        },
      }),
      {
        status: anySuccess ? 200 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
