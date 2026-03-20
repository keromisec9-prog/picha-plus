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
      const signedUrl = await signB2Url(id, env);
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
  const expiry = Math.floor(Date.now() / 1000) + 7200;
  const url = `https://${env.B2_BUCKET}.${env.B2_ENDPOINT}/${fileKey}`;
  return url;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function errorResponse(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
