import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

// Web Push helper functions (no npm dependency needed)
function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function importVapidKeys(publicKeyB64: string, privateKeyB64: string) {
  const publicKeyBytes = base64UrlToUint8Array(publicKeyB64);
  const privateKeyBytes = base64UrlToUint8Array(privateKeyB64);

  const publicKey = await crypto.subtle.importKey(
    "raw",
    publicKeyBytes,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    []
  );

  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: uint8ArrayToBase64Url(publicKeyBytes.slice(1, 33)),
      y: uint8ArrayToBase64Url(publicKeyBytes.slice(33, 65)),
      d: uint8ArrayToBase64Url(privateKeyBytes),
    },
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"]
  );

  return { publicKey, privateKey, publicKeyBytes };
}

async function createJWT(
  endpoint: string,
  vapidPrivateKey: CryptoKey,
  vapidEmail: string
): Promise<string> {
  const origin = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);

  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: origin,
    exp: now + 12 * 60 * 60,
    sub: `mailto:${vapidEmail}`,
  };

  const encoder = new TextEncoder();
  const headerB64 = uint8ArrayToBase64Url(
    encoder.encode(JSON.stringify(header))
  );
  const payloadB64 = uint8ArrayToBase64Url(
    encoder.encode(JSON.stringify(payload))
  );
  const unsignedToken = `${headerB64}.${payloadB64}`;

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    vapidPrivateKey,
    encoder.encode(unsignedToken)
  );

  // Convert DER signature to raw r||s format
  const sigBytes = new Uint8Array(signature);
  let r: Uint8Array, s: Uint8Array;

  if (sigBytes.length === 64) {
    r = sigBytes.slice(0, 32);
    s = sigBytes.slice(32, 64);
  } else {
    // DER format
    let offset = 2;
    const rLen = sigBytes[offset + 1];
    offset += 2;
    const rRaw = sigBytes.slice(offset, offset + rLen);
    r = rRaw.length > 32 ? rRaw.slice(rRaw.length - 32) : rRaw;
    offset += rLen;
    const sLen = sigBytes[offset + 1];
    offset += 2;
    const sRaw = sigBytes.slice(offset, offset + sLen);
    s = sRaw.length > 32 ? sRaw.slice(sRaw.length - 32) : sRaw;
  }

  const rawSig = new Uint8Array(64);
  rawSig.set(r.length < 32 ? new Uint8Array([...new Array(32 - r.length).fill(0), ...r]) : r, 0);
  rawSig.set(s.length < 32 ? new Uint8Array([...new Array(32 - s.length).fill(0), ...s]) : s, 32);

  const sigB64 = uint8ArrayToBase64Url(rawSig);
  return `${unsignedToken}.${sigB64}`;
}

async function encryptPayload(
  payload: string,
  p256dhKey: string,
  authSecret: string
) {
  const clientPublicKey = base64UrlToUint8Array(p256dhKey);
  const clientAuth = base64UrlToUint8Array(authSecret);

  // Generate ephemeral key pair
  const localKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );

  const localPublicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", localKeyPair.publicKey)
  );

  // Import client public key
  const clientKey = await crypto.subtle.importKey(
    "raw",
    clientPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );

  // ECDH shared secret
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: clientKey },
      localKeyPair.privateKey,
      256
    )
  );

  const encoder = new TextEncoder();

  // HKDF for auth
  const authInfo = encoder.encode("WebPush: info\0");
  const authInfoFull = new Uint8Array(
    authInfo.length + clientPublicKey.length + localPublicKeyRaw.length
  );
  authInfoFull.set(authInfo);
  authInfoFull.set(clientPublicKey, authInfo.length);
  authInfoFull.set(localPublicKeyRaw, authInfo.length + clientPublicKey.length);

  const authHkdfKey = await crypto.subtle.importKey(
    "raw",
    clientAuth,
    "HKDF",
    false,
    ["deriveBits"]
  );
  const prk = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: sharedSecret, info: authInfoFull },
      authHkdfKey,
      256
    )
  );

  // Generate salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Derive content encryption key
  const prkKey = await crypto.subtle.importKey("raw", prk, "HKDF", false, [
    "deriveBits",
  ]);
  const cekInfo = encoder.encode("Content-Encoding: aes128gcm\0");
  const contentEncryptionKey = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: cekInfo },
      prkKey,
      128
    )
  );

  // Derive nonce
  const nonceInfo = encoder.encode("Content-Encoding: nonce\0");
  const nonce = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: nonceInfo },
      prkKey,
      96
    )
  );

  // Encrypt
  const payloadBytes = encoder.encode(payload);
  const paddedPayload = new Uint8Array(payloadBytes.length + 2);
  paddedPayload.set(payloadBytes);
  paddedPayload[payloadBytes.length] = 2; // delimiter
  // rest is 0 padding

  const aesKey = await crypto.subtle.importKey(
    "raw",
    contentEncryptionKey,
    "AES-GCM",
    false,
    ["encrypt"]
  );
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      aesKey,
      paddedPayload
    )
  );

  // Build aes128gcm body
  const recordSize = encrypted.length + 86;
  const header = new Uint8Array(86);
  header.set(salt, 0); // 16 bytes salt
  const rsView = new DataView(header.buffer);
  rsView.setUint32(16, recordSize); // 4 bytes record size
  header[20] = 65; // 1 byte key ID length
  header.set(localPublicKeyRaw, 21); // 65 bytes local public key

  const body = new Uint8Array(header.length + encrypted.length);
  body.set(header);
  body.set(encrypted, header.length);

  return body;
}

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

    const { publicKey, privateKey, publicKeyBytes } = await importVapidKeys(
      vapidPublicKey,
      vapidPrivateKey
    );

    const payload = JSON.stringify({ title, body: messageBody });
    const results = [];

    for (const sub of subscriptions) {
      try {
        const jwt = await createJWT(sub.endpoint, privateKey, vapidEmail);
        const encrypted = await encryptPayload(
          payload,
          sub.p256dh,
          sub.auth
        );

        const pushResponse = await fetch(sub.endpoint, {
          method: "POST",
          headers: {
            Authorization: `vapid t=${jwt}, k=${uint8ArrayToBase64Url(publicKeyBytes)}`,
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: "86400",
          },
          body: encrypted,
        });

        if (pushResponse.status === 410 || pushResponse.status === 404) {
          // Subscription expired, clean up
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
        } else if (pushResponse.ok) {
          results.push({ endpoint: sub.endpoint, status: "sent" });
        } else {
          const errText = await pushResponse.text();
          results.push({
            endpoint: sub.endpoint,
            status: "failed",
            error: errText,
          });
        }
      } catch (err) {
        results.push({
          endpoint: sub.endpoint,
          status: "error",
          error: String(err),
        });
      }
    }

    const anySuccess = results.some((r) => r.status === "sent");

    return new Response(
      JSON.stringify({ success: anySuccess, results }),
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
