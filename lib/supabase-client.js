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

// ── Session management ────────────────────────────────────────────────────────

async function getSession() {
  const { supabaseSession: s } = await _get(['supabaseSession']);
  if (!s?.access_token) return null;
  // Refresh proactively if expiring within 60 seconds
  if (Date.now() > s.expires_at - 60000) return _refreshSession(s.refresh_token);
  return s;
}

async function _refreshSession(refreshToken) {
  if (!refreshToken) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) throw new Error('refresh failed');
    const data = await res.json();
    const session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
    await _set({ supabaseSession: session });
    return session;
  } catch {
    await _set({ supabaseSession: null });
    return null;
  }
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
  const res = await _edge('wardrobe', {
    method: 'POST',
    body: JSON.stringify({
      name: item.name,
      category: item.category,
      imageMimeType: item.imageMimeType || 'image/jpeg',
      // Optional fields: omit when null/empty so Zod's .optional() passes (it rejects null)
      brand: item.brand || undefined,
      price: item.price || undefined,
      imageUrl: item.imageUrl || undefined,
      imageBase64: item.imageBase64 || undefined,
      productUrl: item.productUrl || undefined,
      source: item.source || undefined,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = Array.isArray(err.details)
      ? ' — ' + err.details.map(i => `${(i.path || []).join('.') || '?'}: ${i.message}`).join('; ')
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

// Map Supabase avatar row -> local avatar shape
function _mapAvatar(avatar, fallbackPhotoUrl = '') {
  return {
    name: avatar.name || 'Me',
    photoUrl: avatar.signedPhotoUrl || fallbackPhotoUrl,
    createdAt: avatar.created_at ? new Date(avatar.created_at).getTime() : Date.now(),
  };
}

// The avatar function reports zod failures as `details` and model-cascade failures
// as `detail`. Collapsing either into a generic message is how avatar bugs stay
// invisible — same reasoning as the try-on path below.
async function _avatarError(res, fallback) {
  const err = await res.json().catch(() => ({}));
  const msg = err.error || fallback;
  if (Array.isArray(err.details)) {
    const issues = err.details
      .map(i => `${(i.path || []).join('.') || '?'}: ${i.message}`)
      .join('; ');
    return issues ? `${msg} — ${issues}` : msg;
  }
  return err.detail ? `${msg} — ${err.detail}` : msg;
}

async function fetchAvatar() {
  const res = await _edge('avatar');
  if (!res.ok) return null;
  const { avatar } = await res.json();
  if (!avatar) return null;
  return _mapAvatar(avatar);
}

// Legacy single-photo path — saves the photo as the avatar with no generation step.
async function saveAvatarRemote(name, photoDataUrl) {
  const mimeType = photoDataUrl.startsWith('data:')
    ? photoDataUrl.split(';')[0].split(':')[1]
    : 'image/jpeg';
  const base64 = photoDataUrl.includes(',') ? photoDataUrl.split(',')[1] : photoDataUrl;

  const res = await _edge('avatar', {
    method: 'POST',
    body: JSON.stringify({
      name,
      photoBase64: base64,
      photoMimeType: mimeType,
      // omit when absent — the schema is .optional(), which rejects null
    }),
  });
  if (!res.ok) throw new Error(await _avatarError(res, 'Failed to save avatar'));
  const { avatar } = await res.json();
  return _mapAvatar(avatar, photoDataUrl); // fall back to the local data URL
}

// Step 1 of enrollment: 1–4 photos in, 3 candidate avatars out. Slow (a model
// cascade per candidate) and deliberately does not set the avatar — pass `signal`
// so the caller owns the timeout.
async function generateAvatarCandidates({ photos, name, signal }) {
  const res = await _edge('avatar', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      action: 'generate',
      // base64 is the raw payload, never a data: URL — the function atob()s it directly
      photos: photos.map(p => ({ base64: p.base64, mimeType: p.mimeType || 'image/jpeg' })),
      name: name || 'Me',
    }),
  });
  if (!res.ok) throw new Error(await _avatarError(res, 'Avatar generation failed.'));

  const { candidates } = await res.json();
  const usable = (candidates || []).filter(c => c?.path && c?.url);
  if (usable.length === 0) throw new Error('No avatar candidates were returned. Please try again.');
  return usable;
}

// Step 2: promote one candidate to the avatar. The server deletes the rest.
async function commitAvatarCandidate({ candidatePath, name }) {
  const res = await _edge('avatar', {
    method: 'POST',
    body: JSON.stringify({
      action: 'commit',
      candidatePath,
      name: name || 'Me',
    }),
  });
  if (!res.ok) throw new Error(await _avatarError(res, 'Failed to save avatar'));

  const { avatar } = await res.json();
  if (!avatar) throw new Error('Avatar was not saved. Please try again.');
  return _mapAvatar(avatar);
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

  const res = await _edge('tryon', {
    method: 'POST',
    body: JSON.stringify({
      avatarBase64,
      avatarMimeType,
      clothingItems: validItems.map(i => ({
        base64: i.base64,
        mimeType: i.mimeType || 'image/jpeg',
        name: i.name,
        brand: i.brand,
        category: i.category,
      })),
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
