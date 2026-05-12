// lib/supabase-client.js — Supabase auth + Edge Function helpers
// No external library needed — plain fetch calls to Supabase REST APIs.

const SUPABASE_URL = 'https://nsegoojwxdrzeohsvhrd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zZWdvb2p3eGRyemVvaHN2aHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxOTc2NzUsImV4cCI6MjA5Mjc3MzY3NX0.UT7oT4yJ5huFPKkMJQKSZC8oKlnjXgl3eDRSN3QrZL0';

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
      brand: item.brand,
      price: item.price,
      category: item.category,
      imageUrl: item.imageUrl,
      imageBase64: item.imageBase64,
      imageMimeType: item.imageMimeType || 'image/jpeg',
      productUrl: item.productUrl,
      source: item.source,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to save item');
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
    const fetched = await new Promise(resolve =>
      chrome.runtime.sendMessage({ action: 'fetchImageAsBase64', url: src }, resolve)
    );
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
    throw new Error(err.error || 'Try-on generation failed.');
  }

  const data = await res.json();
  // Edge function returns signedUrl (stored in Supabase) or dataUrl (base64 fallback)
  const imageUrl = data.signedUrl || data.dataUrl;
  if (!imageUrl) throw new Error('No image returned from try-on.');
  return { imageUrl };
}
