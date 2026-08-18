// lib/supabase-client.js — Supabase auth + Edge Function helpers
// No external library needed — plain fetch calls to Supabase REST APIs.

const SUPABASE_URL = 'https://nsegoojwxdrzeohsvhrd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zZWdvb2p3eGRyemVvaHN2aHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxOTc2NzUsImV4cCI6MjA5Mjc3MzY3NX0.UT7oT4yJ5huFPKkMJQKSZC8oKlnjXgl3eDRSN3QrZL0';

// ── Background message helper (with timeout to handle sleeping MV3 worker) ────

function _sendMessageWithTimeout(message, timeoutMs = 8000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    try {
      chrome.runtime.sendMessage(message, response => {
        clearTimeout(timer);
        resolve(response ?? null);
      });
    } catch (e) {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

// ── Chrome storage helpers (self-contained) ───────────────────────────────────

function _get(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
function _set(data) {
  return new Promise(resolve => chrome.storage.local.set(data, resolve));
}

// ── Image helper ──────────────────────────────────────────────────────────────

// Downscale a base64 image to at most `maxDim` on its long edge and re-encode as
// JPEG. Big source images are the dominant try-on latency/cost driver, so this
// shrinks the upload + Gemini ingest time. Falls back to the original on any
// error (OffscreenCanvas/createImageBitmap are available in the popup context).
async function _downscaleBase64(base64, mimeType, maxDim = 1024, quality = 0.85) {
  try {
    const blob = await (await fetch(`data:${mimeType};base64,${base64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    if (scale >= 1) { bmp.close?.(); return { base64, mimeType }; } // already small enough
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const bytes = new Uint8Array(await outBlob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return { base64: btoa(bin), mimeType: 'image/jpeg' };
  } catch {
    return { base64, mimeType }; // never block a try-on because resizing failed
  }
}

// ── Session management ────────────────────────────────────────────────────────

// Shared in-flight refresh so concurrent callers don't each burn the (rotating)
// refresh token. Supabase rotates the refresh token on every use, so a second
// concurrent refresh with the same token would 400 and wipe the session — the
// P0-2 sign-out-during-avatar bug. All callers await the same refresh instead.
let _refreshInFlight = null;

async function getSession() {
  const { supabaseSession: s } = await _get(['supabaseSession']);
  if (!s?.access_token) return null;
  // Refresh proactively if expiring within 60 seconds
  if (Date.now() > s.expires_at - 60000) return _refreshSession(s);
  return s;
}

async function _refreshSession(currentSession) {
  const refreshToken = currentSession?.refresh_token;
  if (!refreshToken) return null;

  // Single-flight: if a refresh is already running, everyone awaits that one.
  if (_refreshInFlight) return _refreshInFlight;

  _refreshInFlight = (async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      if (res.ok) {
        const data = await res.json();
        const session = {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: Date.now() + data.expires_in * 1000,
        };
        await _set({ supabaseSession: session });
        return session;
      }

      // Definitive auth failure (bad / expired / already-used refresh token) →
      // the session really is dead, so sign out.
      if (res.status === 400 || res.status === 401) {
        await _set({ supabaseSession: null });
        return null;
      }

      // Transient server error (5xx / 429 / …) → do NOT wipe the session. Return
      // the current one so the caller can still try its token (valid up to ~60s).
      return currentSession;
    } catch {
      // Network error / timeout → transient; keep the session, don't sign out.
      return currentSession;
    } finally {
      _refreshInFlight = null;
    }
  })();

  return _refreshInFlight;
}

async function getUser() {
  const session = await getSession();
  if (!session?.access_token) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── PKCE helpers ─────────────────────────────────────────────────────────────

function _generateVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function _generateChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Opens a Chrome OAuth popup using PKCE flow and returns the session.
async function signInWithGoogle() {
  const redirectUrl = chrome.identity.getRedirectURL();

  // Generate PKCE pair
  const codeVerifier = _generateVerifier();
  const codeChallenge = await _generateChallenge(codeVerifier);

  const authUrl =
    `${SUPABASE_URL}/auth/v1/authorize?provider=google` +
    `&redirect_to=${encodeURIComponent(redirectUrl)}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&code_challenge_method=S256`;

  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, url => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!url) reject(new Error('Sign-in cancelled'));
      else resolve(url);
    });
  });

  const parsed = new URL(responseUrl);
  const code = parsed.searchParams.get('code');
  if (code) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error_description || err.message || 'Token exchange failed');
    }
    const data = await res.json();
    const session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
    await _set({ supabaseSession: session });
    return session;
  }

  // Implicit flow fallback: tokens in URL fragment
  const params = new URLSearchParams(parsed.hash.slice(1));
  const accessToken = params.get('access_token');
  if (!accessToken) throw new Error('Sign-in failed — no token returned');

  const session = {
    access_token: accessToken,
    refresh_token: params.get('refresh_token'),
    expires_at: Date.now() + parseInt(params.get('expires_in') || '3600') * 1000,
  };
  await _set({ supabaseSession: session });
  return session;
}

async function signOut() {
  const session = await getSession();
  if (session?.access_token) {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
    }).catch(() => {});
  }
  await _set({ supabaseSession: null });
}

// ── Edge Function helper ──────────────────────────────────────────────────────

async function _edge(name, options = {}) {
  const session = await getSession();
  const token = session?.access_token || SUPABASE_ANON_KEY;
  return fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
}

// ── Profile API ───────────────────────────────────────────────────────────────

async function fetchProfile() {
  const session = await getSession();
  if (!session?.access_token) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?select=try_on_count,try_on_limit&limit=1`,
      {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_ANON_KEY,
          Accept: 'application/json',
        },
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? (data[0] || null) : null;
  } catch {
    return null;
  }
}

// ── Wardrobe API ──────────────────────────────────────────────────────────────

async function fetchWardrobe() {
  const res = await _edge('wardrobe');
  if (!res.ok) throw new Error('Failed to load wardrobe');
  const { items } = await res.json();
  return (items || []).map(_mapItem);
}

async function saveWardrobeItem(item) {
  // The wardrobe edge fn validates with Zod, whose `.optional()` accepts
  // `undefined` but REJECTS `null` — and whose `imageUrl` must be a valid
  // absolute URL. Scraped items frequently have `null` price/image/brand or a
  // relative image src, so sending them verbatim 400s ("Invalid request").
  // Build the payload with only the fields that pass validation: omit
  // empty/null optionals, and drop non-http URLs.
  const isHttpUrl = v => typeof v === 'string' && /^https?:\/\//i.test(v);
  const nonEmpty = v => (typeof v === 'string' && v.trim() ? v : undefined);

  const body = {
    name: item.name,
    category: item.category,
    imageMimeType: item.imageMimeType || 'image/jpeg',
  };
  const brand = nonEmpty(item.brand);
  if (brand) body.brand = brand;
  const price = nonEmpty(item.price);
  if (price) body.price = price;
  const source = nonEmpty(item.source);
  if (source) body.source = source;
  const imageBase64 = nonEmpty(item.imageBase64);
  if (imageBase64) body.imageBase64 = imageBase64;
  if (isHttpUrl(item.imageUrl)) body.imageUrl = item.imageUrl;
  if (isHttpUrl(item.productUrl)) body.productUrl = item.productUrl;

  const res = await _edge('wardrobe', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // Surface the edge fn's Zod validation detail (which field/why) so a 400
    // names the offending field instead of a generic "Invalid request".
    const detail = Array.isArray(err.details)
      ? ' — ' + err.details.map(i => `${(i.path || []).join('.') || '(root)'}: ${i.message}`).join('; ')
      : '';
    throw new Error((err.error || 'Failed to save item') + detail);
  }
  return _mapItem((await res.json()).item);
}

async function deleteWardrobeItem(id) {
  const res = await _edge(`wardrobe?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete item');
}

// Map Supabase DB row → local item shape
function _mapItem(item) {
  return {
    id: item.id,
    name: item.name,
    brand: item.brand || '',
    price: item.price || '',
    category: item.category,
    imageUrl: item.signedImageUrl || item.image_url || '',
    productUrl: item.product_url || '',
    source: item.source || '',
    savedAt: item.saved_at ? new Date(item.saved_at).getTime() : Date.now(),
  };
}

// ── Avatar API ────────────────────────────────────────────────────────────────

async function fetchAvatar() {
  const res = await _edge('avatar');
  if (!res.ok) return null;
  const { avatar } = await res.json();
  if (!avatar) return null;
  return {
    name: avatar.name || 'Me',
    photoUrl: avatar.signedPhotoUrl || '',
    createdAt: avatar.created_at ? new Date(avatar.created_at).getTime() : Date.now(),
  };
}

async function saveAvatarRemote(name, photoDataUrl) {
  const mimeType = photoDataUrl.startsWith('data:')
    ? photoDataUrl.split(';')[0].split(':')[1]
    : 'image/jpeg';
  const base64 = photoDataUrl.includes(',') ? photoDataUrl.split(',')[1] : photoDataUrl;

  const res = await _edge('avatar', {
    method: 'POST',
    body: JSON.stringify({ name, photoBase64: base64, photoMimeType: mimeType }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to save avatar');
  }
  const { avatar } = await res.json();
  return {
    name: avatar.name || 'Me',
    photoUrl: avatar.signedPhotoUrl || photoDataUrl, // fallback to local data URL
    createdAt: avatar.created_at ? new Date(avatar.created_at).getTime() : Date.now(),
  };
}

// ── Try-On API ────────────────────────────────────────────────────────────────

async function generateTryOnRemote(avatar, clothingItems) {
  const src = avatar.photoUrl;
  if (!src) throw new Error('Avatar photo not available. Please re-upload in the Avatar tab.');

  // photoUrl may be a data: URL (just uploaded) or a signed https: URL (loaded from Supabase)
  let avatarBase64, avatarMimeType;
  if (src.startsWith('data:')) {
    avatarMimeType = src.split(';')[0].split(':')[1];
    avatarBase64 = src.split(',')[1];
  } else {
    // Fetch the signed URL and convert to base64
    const fetched = await _sendMessageWithTimeout({ action: 'fetchImageAsBase64', url: src });
    if (!fetched?.success) throw new Error('Could not load avatar photo. Try re-uploading.');
    avatarBase64 = fetched.data.base64;
    avatarMimeType = fetched.data.mimeType;
  }

  const validItems = clothingItems.filter(i => i.base64);
  if (validItems.length === 0) throw new Error('No clothing images available.');

  // Downscale everything before upload. Raw phone photos (often 3000×4000px) are
  // the main try-on latency + cost driver: they're slow to upload and slow for
  // Gemini to ingest. 1024px is plenty for a photorealistic result.
  const avatarSmall = await _downscaleBase64(avatarBase64, avatarMimeType);
  const clothingSmall = await Promise.all(
    validItems.map(async i => {
      const small = await _downscaleBase64(i.base64, i.mimeType || 'image/jpeg');
      return {
        base64: small.base64,
        mimeType: small.mimeType,
        name: i.name,
        brand: i.brand,
        category: i.category,
      };
    })
  );

  const res = await _edge('tryon', {
    method: 'POST',
    body: JSON.stringify({
      avatarBase64: avatarSmall.base64,
      avatarMimeType: avatarSmall.mimeType,
      clothingItems: clothingSmall,
    }),
  });

  if (res.status === 429) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Try-on limit reached.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // `detail` carries the per-model failure reasons from the edge function — without
    // it a total cascade failure is indistinguishable from any other 500.
    const msg = err.error || 'Try-on generation failed.';
    throw new Error(err.detail ? `${msg} — ${err.detail}` : msg);
  }

  const data = await res.json();
  // Edge function returns signedUrl (stored in Supabase) or dataUrl (base64 fallback)
  const imageUrl = data.signedUrl || data.dataUrl;
  if (!imageUrl) throw new Error('No image returned from try-on.');
  return { imageUrl, storagePath: data.storagePath || null };
}
