const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Session-Token',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === '/auth/google') {
      const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      u.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
      u.searchParams.set('redirect_uri', env.REDIRECT_URI);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', 'openid email profile');
      u.searchParams.set('prompt', 'select_account');
      return Response.redirect(u.toString(), 302);
    }

    if (url.pathname === '/auth/callback') {
      const code = url.searchParams.get('code');
      if (!code) return errorResponse('Missing code', 400);
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: env.REDIRECT_URI, grant_type: 'authorization_code' }),
      });
      const tokens = await tokenRes.json();
      if (!tokens.access_token) return errorResponse('Auth failed', 401);
      const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      const profile = await profileRes.json();
      const existing = await env.KV.get(`user:${profile.id}`);
      let user = existing ? JSON.parse(existing) : { googleId: profile.id, email: profile.email, name: profile.name, picture: profile.picture, subscribed: false, subscriptionPlan: null, subscriptionExpiry: null, watchProgress: {}, createdAt: Date.now() };
      user.name = profile.name; user.picture = profile.picture; user.lastLogin = Date.now();
      await env.KV.put(`user:${profile.id}`, JSON.stringify(user));
      const session = `pichaplus_${Date.now()}_${profile.id}`;
      await env.KV.put(`session:${session}`, profile.id, { expirationTtl: 2592000 });
      const redirect = new URL(env.SITE_URL);
      redirect.searchParams.set('session', session);
      redirect.searchParams.set('name', profile.name);
      redirect.searchParams.set('picture', profile.picture);
      redirect.searchParams.set('email', profile.email);
      return Response.redirect(redirect.toString(), 302);
    }

    if (url.pathname === '/me') {
      const user = await getUser(request, env);
      if (!user) return errorResponse('Not authenticated', 401);
      if (user.subscribed && user.subscriptionExpiry && Date.now() > user.subscriptionExpiry) {
        user.subscribed = false; user.subscriptionPlan = null;
        await env.KV.put(`user:${user.googleId}`, JSON.stringify(user));
      }
      return jsonResponse(user);
    }

    if (url.pathname === '/videos') {
      const data = await env.KV.get('catalog', { type: 'json' });
      return jsonResponse(data || { movies: [], series: [] });
    }

    if (url.pathname === '/video') {
      const id = url.searchParams.get('id');
      if (!id) return errorResponse('Missing id', 400);
      const user = await getUser(request, env);
      if (!user) return errorResponse('Sign in required', 401);
      if (!user.subscribed) return errorResponse('Subscription required', 402);
      if (user.subscriptionExpiry && Date.now() > user.subscriptionExpiry) return errorResponse('Subscription expired', 402);
      const catalog = await env.KV.get('catalog', { type: 'json' });
      const entry = catalog?.movies?.[id] || catalog?.series?.[id];
      if (!entry) return errorResponse('Video not found', 404);
      const signedUrl = await signB2Url(entry.fileName, env);
      return jsonResponse({ url: signedUrl });
    }

    if (url.pathname === '/progress' && request.method === 'POST') {
      const user = await getUser(request, env);
      if (!user) return errorResponse('Not authenticated', 401);
      const body = await request.json();
      user.watchProgress = user.watchProgress || {};
      user.watchProgress[body.videoId] = { position: body.position, duration: body.duration, updatedAt: Date.now() };
      await env.KV.put(`user:${user.googleId}`, JSON.stringify(user));
      return jsonResponse({ success: true });
    }

    if (url.pathname === '/likes' && request.method === 'POST') {
      const body = await request.json();
      const key = `likes:${body.videoId}`;
      const current = parseInt(await env.KV.get(key) || '0');
      await env.KV.put(key, (current + 1).toString());
      return jsonResponse({ likes: current + 1 });
    }

    if (url.pathname === '/likes') {
      const id = url.searchParams.get('videoId');
      const count = parseInt(await env.KV.get(`likes:${id}`) || '0');
      return jsonResponse({ likes: count });
    }

    // ── PAYMENTS ──────────────────────────────────────────────────────────────
    if (url.pathname === '/pay' && request.method === 'POST') {
      const user = await getUser(request, env);
      if (!user) return errorResponse('Not authenticated', 401);
      const body = await request.json();
      const plans = {
        daily:     { amount: 2000,   days: 1,   label: 'Picha+ Daily Pass' },
        monthly:   { amount: 15000,  days: 30,  label: 'Picha+ Monthly' },
        quarterly: { amount: 60000,  days: 90,  label: 'Picha+ Quarterly' },
        yearly:    { amount: 120000, days: 365, label: 'Picha+ Yearly' },
      };
      const plan = plans[body.plan];
      if (!plan) return errorResponse('Invalid plan', 400);

      try {
        // Get PesaPal token
        const tokenRes = await fetch('https://pay.pesapal.com/v3/api/Auth/RequestToken', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ consumer_key: env.PESAPAL_CONSUMER_KEY, consumer_secret: env.PESAPAL_CONSUMER_SECRET }),
        });
        const { token } = await tokenRes.json();
        if (!token) return errorResponse('PesaPal auth failed', 500);

        // Register IPN
        const ipnRes = await fetch('https://pay.pesapal.com/v3/api/URLSetup/RegisterIPN', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ url: env.PESAPAL_IPN_URL, ipn_notification_type: 'GET' }),
        });
        const { ipn_id } = await ipnRes.json();

        const orderRef = `PICHAPLUS-${Date.now()}-${user.googleId.slice(-6)}`;

        // Submit order
        const orderRes = await fetch('https://pay.pesapal.com/v3/api/Transactions/SubmitOrderRequest', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            id: orderRef,
            currency: 'UGX',
            amount: plan.amount,
            description: plan.label,
            callback_url: `${env.SITE_URL}?payment=success&plan=${body.plan}&session=${request.headers.get('X-Session-Token')}`,
            notification_id: ipn_id,
            billing_address: {
              email_address: user.email || '',
              first_name: (user.name || '').split(' ')[0] || 'User',
              last_name: (user.name || '').split(' ').slice(1).join(' ') || '',
            },
          }),
        });
        const orderData = await orderRes.json();
        if (!orderData.redirect_url) return errorResponse('Payment initiation failed', 500);

        // Store pending order
        await env.KV.put(`order:${orderData.order_tracking_id}`, JSON.stringify({
          userId: user.googleId,
          plan: body.plan,
          days: plan.days,
          amount: plan.amount,
          createdAt: Date.now(),
        }), { expirationTtl: 3600 });

        return jsonResponse({ redirectUrl: orderData.redirect_url, orderTrackingId: orderData.order_tracking_id });
      } catch (err) {
        return errorResponse('Payment failed: ' + err.message, 500);
      }
    }

    // ── IPN ───────────────────────────────────────────────────────────────────
    if (url.pathname === '/ipn') {
      const orderTrackingId = url.searchParams.get('OrderTrackingId');
      const orderMerchantRef = url.searchParams.get('OrderMerchantReference');
      if (!orderTrackingId) return new Response('OK');

      try {
        const tokenRes = await fetch('https://pay.pesapal.com/v3/api/Auth/RequestToken', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ consumer_key: env.PESAPAL_CONSUMER_KEY, consumer_secret: env.PESAPAL_CONSUMER_SECRET }),
        });
        const { token } = await tokenRes.json();

        const statusRes = await fetch(`https://pay.pesapal.com/v3/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`, {
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        });
        const status = await statusRes.json();

        if (status.payment_status_description === 'Completed') {
          const orderData = await env.KV.get(`order:${orderTrackingId}`, { type: 'json' });
          if (orderData) {
            const userData = await env.KV.get(`user:${orderData.userId}`, { type: 'json' });
            if (userData) {
              userData.subscribed = true;
              userData.subscriptionPlan = orderData.plan;
              userData.subscriptionExpiry = Date.now() + (orderData.days * 24 * 60 * 60 * 1000);
              await env.KV.put(`user:${orderData.userId}`, JSON.stringify(userData));
              await env.KV.delete(`order:${orderTrackingId}`);
            }
          }
        }
      } catch {}
      return new Response('OK');
    }

    // ── VERIFY PAYMENT ────────────────────────────────────────────────────────
    if (url.pathname === '/verify') {
      const orderTrackingId = url.searchParams.get('orderTrackingId');
      if (!orderTrackingId) return errorResponse('Missing orderTrackingId', 400);
      const user = await getUser(request, env);
      if (!user) return errorResponse('Not authenticated', 401);
      return jsonResponse({ completed: user.subscribed, user });
    }

    if (url.pathname === '/auth/logout') {
      const session = request.headers.get('X-Session-Token');
      if (session) await env.KV.delete(`session:${session}`);
      return jsonResponse({ success: true });
    }

    return new Response('Picha Plus API', { headers: CORS });
  }
};

async function getUser(request, env) {
  const token = request.headers.get('X-Session-Token');
  if (!token) return null;
  try {
    const userId = await env.KV.get(`session:${token}`);
    if (!userId) return null;
    const data = await env.KV.get(`user:${userId}`);
    return data ? JSON.parse(data) : null;
  } catch { return null; }
}

async function signB2Url(fileKey, env) {
  try {
    // Get B2 download authorization
    const authRes = await fetch(`https://api.backblazeb2.com/b2api/v3/b2_authorize_account`, {
      headers: {
        'Authorization': 'Basic ' + btoa(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`)
      }
    });
    const auth = await authRes.json();

    // Get download auth token for the file
    const dlAuthRes = await fetch(`${auth.apiInfo.storageApi.apiUrl}/b2api/v3/b2_get_download_authorization`, {
      method: 'POST',
      headers: {
        'Authorization': auth.authorizationToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        bucketId: '12307e629a2c029791d4061b',
        fileNamePrefix: fileKey,
        validDurationInSeconds: 7200
      })
    });
    const dlAuth = await dlAuthRes.json();

    const downloadUrl = `${auth.apiInfo.storageApi.downloadUrl}/file/${env.B2_BUCKET}/${fileKey}?Authorization=${dlAuth.authorizationToken}`;
    return downloadUrl;
  } catch (err) {
    // Fallback to direct URL
    return `https://${env.B2_BUCKET}.${env.B2_ENDPOINT}/${fileKey}`;
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function errorResponse(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
