// popup.js — Main popup logic for Aura extension

// ===== ICONS =====
// Inline SVG line glyphs — icon-font CDNs are blocked by the MV3 content security policy.
const svgIcon = (paths, size = 40) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICON = {
  alert: svgIcon('<circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5"></path><path d="M12 16h.01"></path>'),
  search: svgIcon('<circle cx="10.5" cy="10.5" r="6.5"></circle><path d="M15.5 15.5 21 21"></path>'),
  hanger: svgIcon('<path d="M12 4.5a1.75 1.75 0 1 0-1.75 1.75c.97 0 1.75.78 1.75 1.75v1.2"></path><path d="M12 9.2 3.6 15.3a1.2 1.2 0 0 0 .7 2.2h15.4a1.2 1.2 0 0 0 .7-2.2L12 9.2Z"></path>'),
  person: svgIcon('<circle cx="12" cy="8" r="4"></circle><path d="M4.5 20a7.5 7.5 0 0 1 15 0"></path>'),
  sparkle: svgIcon('<path d="M12 3.5 13.8 9 19.5 12 13.8 15 12 20.5 10.2 15 4.5 12 10.2 9 12 3.5Z"></path>'),
};

// ===== STATE =====
let wardrobe = [];
let avatar = null;
let profile = null;
let selectedItems = new Set(); // item IDs selected for try-on
let currentFilter = 'all';

// ===== INIT =====
document.addEventListener('DOMContentLoaded', async () => {
  setupAuth();
  try {
    const user = await getUser();
    if (!user) {
      showAuthScreen();
      return;
    }
    await loadState();
    showMainApp();
  } catch (err) {
    // Never leave the boot spinner up forever — fall back to sign-in.
    console.error('Startup failed:', err);
    showAuthScreen();
  }
});

function hideBootScreen() {
  document.getElementById('boot-screen').classList.add('hidden');
}

function showAuthScreen() {
  hideBootScreen();
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('main-app').classList.add('hidden');
}

function showMainApp() {
  hideBootScreen();
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('main-app').classList.remove('hidden');
  setupTabs();
  setupDetectTab();
  setupWardrobeTab();
  setupAvatarTab();
  setupTryOnTab();
  setupLooksTab();
  setupSettings();

  // Show item saved via right-click context menu
  if (window._pendingContextItem) {
    const item = window._pendingContextItem;
    window._pendingContextItem = null;
    const container = document.getElementById('detected-products');
    renderDetectedProducts([item], container);
    const banner = document.createElement('div');
    banner.className = 'context-save-banner';
    banner.textContent = 'Right-clicked item — review and save:';
    container.insertBefore(banner, container.firstChild);
  }
}

function setupAuth() {
  document.getElementById('google-signin-btn').addEventListener('click', async () => {
    const btn = document.getElementById('google-signin-btn');
    const errEl = document.getElementById('auth-error');
    btn.textContent = 'Signing in...';
    btn.disabled = true;
    errEl.classList.add('hidden');
    try {
      await signInWithGoogle();
      await loadState();
      showMainApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      btn.innerHTML = '<span class="google-icon">G</span> Sign in with Google';
      btn.disabled = false;
    }
  });
}

async function loadState() {
  // All three run concurrently — fetchProfile used to wait on the other two,
  // adding a whole serial round-trip to every popup open. allSettled so one
  // failure can't blank the others.
  const [wardrobeRes, avatarRes, profileRes] = await Promise.allSettled([
    fetchWardrobe(),
    fetchAvatar(),
    fetchProfile(),
  ]);

  wardrobe = wardrobeRes.status === 'fulfilled' ? wardrobeRes.value : [];
  avatar = avatarRes.status === 'fulfilled' ? avatarRes.value : null;
  profile = profileRes.status === 'fulfilled' ? profileRes.value : null;

  const loadFailure = wardrobeRes.reason ?? avatarRes.reason;
  if (loadFailure) {
    console.error('Failed to load from Supabase:', loadFailure);
    window._wardrobeLoadError = loadFailure.message;
  }

  // Pick up any item saved via right-click context menu
  const { pendingContextItem } = await new Promise(resolve =>
    chrome.storage.local.get(['pendingContextItem'], resolve)
  );
  if (pendingContextItem) {
    chrome.storage.local.remove('pendingContextItem');
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
    window._pendingContextItem = pendingContextItem;
  }
}

// ===== CHROME STORAGE HELPERS =====
function chromeGet(area, keys) {
  return new Promise(resolve => chrome.storage[area].get(keys, resolve));
}

function chromeSet(area, data) {
  return new Promise(resolve => chrome.storage[area].set(data, resolve));
}

// ===== TABS =====
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === `${name}-tab`));

  if (name === 'wardrobe') renderWardrobe();
  if (name === 'avatar') renderAvatarTab();
  if (name === 'tryon') renderTryOnTab();
  if (name === 'looks') renderLooksTab();
}

// ===== DETECT TAB =====
function setupDetectTab() {
  document.getElementById('scan-btn').addEventListener('click', scanPage);
}

async function scanPage() {
  const btn = document.getElementById('scan-btn');
  const container = document.getElementById('detected-products');

  btn.textContent = 'Scanning…';
  btn.disabled = true;
  container.innerHTML = '<div class="loader"><div class="spinner"></div><span>Detecting clothing items</span></div>';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Inject content script first (handles cases where it may not have loaded)
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});

    chrome.tabs.sendMessage(tab.id, { action: 'aura_detect' }, response => {
      const products = response?.products || [];
      if (response?.error) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">${ICON.alert}</div><h3>Scan error</h3><p>${esc(response.error)}</p></div>`;
      } else if (!response) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">${ICON.alert}</div><h3>No response</h3><p>Please refresh the page and try again.</p></div>`;
      } else if (products.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">${ICON.search}</div>
            <h3>Nothing detected</h3>
            <p>Open a product page (not a homepage), wait for it to fully load, then scan again. Works best on Myntra, H&M, ASOS, and SSENSE.</p>
          </div>`;
      } else {
        renderDetectedProducts(products, container);
      }
      btn.textContent = 'Scan This Page';
      btn.disabled = false;
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">${ICON.alert}</div><h3>Scan failed</h3><p>${err.message}</p></div>`;
    btn.textContent = 'Scan This Page';
    btn.disabled = false;
  }
}

function renderDetectedProducts(products, container) {
  container.innerHTML = '';
  products.forEach(product => {
    const alreadySaved = wardrobe.some(
      w => w.productUrl === product.productUrl || w.name === product.name
    );

    const card = document.createElement('div');
    card.className = 'product-card';
    card.innerHTML = `
      <img class="product-card-img" src="${product.imageUrl}" alt="${esc(product.name)}" loading="lazy"
           onerror="this.style.display='none'">
      <div class="product-card-info">
        <p class="product-card-brand">${esc(product.brand || '')}</p>
        <p class="product-card-name">${esc(truncate(product.name, 60))}</p>
        <div class="product-card-meta">
          <span class="product-card-price">${esc(product.price || '')}</span>
          <span class="product-card-category">${esc(product.category)}</span>
        </div>
      </div>
      <button class="save-btn ${alreadySaved ? 'saved' : ''}" ${alreadySaved ? 'disabled' : ''}>
        ${alreadySaved ? 'In Wardrobe' : 'Save to Wardrobe'}
      </button>
    `;

    const saveBtn = card.querySelector('.save-btn');
    if (!alreadySaved) {
      saveBtn.addEventListener('click', () => saveProduct(product, saveBtn));
    }
    container.appendChild(card);
  });
}

async function saveProduct(product, btn) {
  const duplicate = wardrobe.some(
    w => w.productUrl === product.productUrl || w.name === product.name
  );
  if (duplicate) {
    btn.textContent = 'In Wardrobe';
    btn.classList.add('saved');
    btn.disabled = true;
    return;
  }

  btn.textContent = '⏳ Saving...';
  btn.disabled = true;

  // Use pre-fetched base64 (from right-click menu) or fetch now via background
  let imageBase64, imageMimeType;
  if (product.imageBase64) {
    imageBase64 = product.imageBase64;
    imageMimeType = product.imageMimeType || 'image/jpeg';
  } else {
    const imgResult = await _sendMessageWithTimeout({ action: 'fetchImageAsBase64', url: product.imageUrl });
    imageBase64 = imgResult?.success ? imgResult.data.base64 : null;
    imageMimeType = imgResult?.success ? imgResult.data.mimeType : 'image/jpeg';
  }

  try {
    const saved = await saveWardrobeItem({
      name: product.name,
      brand: product.brand,
      price: product.price,
      category: product.category,
      imageUrl: product.imageUrl,
      imageBase64,
      imageMimeType,
      productUrl: product.productUrl,
      source: product.source,
    });
    wardrobe.push(saved);
    btn.textContent = 'In Wardrobe';
    btn.classList.add('saved');
    btn.disabled = true;
    // Remove any previous error
    btn.parentElement?.querySelector('.save-error')?.remove();
  } catch (err) {
    btn.textContent = '＋ Save to Wardrobe';
    btn.disabled = false;
    // Show error directly under the button so we can see what's wrong
    let errEl = btn.parentElement?.querySelector('.save-error');
    if (!errEl) {
      errEl = document.createElement('p');
      errEl.className = 'save-error';
      errEl.style.cssText = 'color:red;font-size:11px;margin:4px 0 0;word-break:break-word';
      btn.insertAdjacentElement('afterend', errEl);
    }
    errEl.textContent = err.message;
  }
}

// ===== WARDROBE TAB =====
function setupWardrobeTab() {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderWardrobe();
    });
  });

  document.getElementById('wardrobe-search').addEventListener('input', renderWardrobe);

  document.getElementById('create-outfit-btn').addEventListener('click', () => {
    switchTab('tryon');
  });
}

function renderWardrobe() {
  const grid = document.getElementById('wardrobe-grid');
  const footer = document.getElementById('wardrobe-footer');

  const searchTerm = document.getElementById('wardrobe-search')?.value.trim().toLowerCase() || '';
  const searched = searchTerm
    ? wardrobe.filter(i =>
        (i.name || '').toLowerCase().includes(searchTerm) ||
        (i.brand || '').toLowerCase().includes(searchTerm)
      )
    : wardrobe;
  const filtered = currentFilter === 'all'
    ? searched
    : searched.filter(i => i.category === currentFilter);

  if (filtered.length === 0) {
    const loadErr = window._wardrobeLoadError;
    const emptyMsg = loadErr
      ? { title: 'Failed to load wardrobe', hint: loadErr }
      : wardrobe.length === 0
        ? { title: 'Your wardrobe is empty', hint: 'Scan a fashion website to add items' }
        : searchTerm
          ? { title: 'No results', hint: `No items matching "${searchTerm}"` }
          : { title: 'No items in this category', hint: 'Try a different filter' };
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon">${loadErr ? ICON.alert : ICON.hanger}</div>
        <h3>${emptyMsg.title}</h3>
        <p>${esc(emptyMsg.hint)}</p>
      </div>`;
    footer.classList.add('hidden');
    return;
  }

  grid.innerHTML = '';
  filtered.forEach(item => {
    const isSelected = selectedItems.has(item.id);
    const card = document.createElement('div');
    card.className = `wardrobe-card${isSelected ? ' selected' : ''}`;
    card.dataset.id = item.id;
    card.innerHTML = `
      <div class="selected-check">✓</div>
      <img src="${item.imageUrl}" alt="${esc(item.name)}" loading="lazy" onerror="this.style.display='none'">
      ${item.source ? `<span class="wardrobe-card-source">${esc(item.source)}</span>` : ''}
      <div class="wardrobe-card-info">
        <p class="wardrobe-card-brand">${esc(item.brand || '')}</p>
        <p class="wardrobe-card-name">${esc(truncate(item.name, 35))}</p>
        ${item.price ? `<p class="wardrobe-card-price">${esc(item.price)}</p>` : ''}
      </div>
      <button class="delete-card-btn" title="Remove">✕</button>
    `;

    card.addEventListener('click', () => toggleSelection(item.id));
    card.querySelector('.delete-card-btn').addEventListener('click', async e => {
      e.stopPropagation();
      selectedItems.delete(item.id);
      wardrobe = wardrobe.filter(w => w.id !== item.id);
      renderWardrobe();
      deleteWardrobeItem(item.id).catch(err => console.error('Delete failed:', err.message));
    });

    grid.appendChild(card);
  });

  // Footer
  if (selectedItems.size > 0) {
    footer.classList.remove('hidden');
    document.getElementById('create-outfit-btn').textContent =
      `Try On Selected (${selectedItems.size})`;
  } else {
    footer.classList.add('hidden');
  }
}

function toggleSelection(id) {
  if (selectedItems.has(id)) {
    selectedItems.delete(id);
  } else {
    selectedItems.add(id);
  }
  renderWardrobe();
}

// ===== AVATAR TAB =====
// Enrollment is a three-pane flow — form → progress → candidate picker — driven by
// `avatarPane` so switching tabs mid-flow can never strand the user on a dead screen.

// One photo is enough to generate an avatar — the server accepts min(1) and
// blocking on a second is onboarding friction before the user has seen anything
// work. Extra photos genuinely help identity consistency, so they are encouraged
// in the label copy rather than required.
const MIN_PHOTOS = 1;
const RECOMMENDED_PHOTOS = 2;
const MAX_PHOTOS = 4;                 // server ceiling (model character-reference limit)
const MAX_FILE_BYTES = 12 * 1024 * 1024;
// Ported from the single-photo validator: a bad photo fails at generation time
// otherwise, minutes later and with a useless error.
const MIN_FILE_BYTES = 5 * 1024;      // empty or truncated file
const MIN_PHOTO_DIM = 256;            // px per side — below this the try-on is poor
const MAX_PHOTO_ASPECT = 2.6;         // wider/taller than this is a banner, not a person
const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MAX_PHOTO_B64 = 1500000;        // ~1.1 MB of JPEG per photo
const MAX_TOTAL_B64 = 4500000;        // keeps the JSON body comfortably small
// Progressively cheaper encodings, tried in order until one fits MAX_PHOTO_B64.
// 1280px on the long edge is already more than the model uses for a reference.
const ENCODE_STEPS = [[1280, 0.82], [1024, 0.72], [800, 0.62]];
const GENERATE_TIMEOUT_MS = 180000;   // a hung request must not become a forever spinner
const CANDIDATE_TTL_MS = 30 * 60 * 1000;

let avatarPhotos = [];                // { id, dataUrl, base64, mimeType, fileName }
let avatarCandidates = [];            // { path, url } from the server
let selectedCandidate = null;         // candidatePath
let avatarDraft = { name: 'Me' };     // name/measurements captured at generate time
let avatarPane = 'idle';              // 'idle' | 'form' | 'progress' | 'candidates'

function setupAvatarTab() {
  const uploadInput = document.getElementById('avatar-upload-input');

  document.getElementById('avatar-upload-area').addEventListener('click', () => uploadInput.click());
  uploadInput.addEventListener('change', handlePhotoSelection);

  document.getElementById('save-avatar-btn').addEventListener('click', handleAvatarGenerate);
  document.getElementById('avatar-commit-btn').addEventListener('click', handleAvatarCommit);
  document.getElementById('avatar-restart-btn').addEventListener('click', async () => {
    await clearStoredCandidates();
    avatarPane = 'form';
    renderAvatarTab();
  });

  renderAvatarTab();
  restoreStoredCandidates();
}

// ── Photo intake ─────────────────────────────────────────────────────────────

async function handlePhotoSelection(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = ''; // so the same file can be re-picked after a removal
  if (files.length === 0) return;

  clearAvatarError();
  const room = MAX_PHOTOS - avatarPhotos.length;
  if (room <= 0) {
    showAvatarError(`You can use up to ${MAX_PHOTOS} photos — remove one first.`);
    return;
  }

  // Additive: new files join the existing set rather than replacing it.
  const accepted = files.slice(0, room);
  const problems = files.length > room
    ? [`Only ${room} of ${files.length} photos were added (${MAX_PHOTOS} max).`]
    : [];

  const btn = document.getElementById('save-avatar-btn');
  btn.disabled = true;
  setUploadLabel('Processing photos…');
  for (const file of accepted) {
    try {
      avatarPhotos.push(await processPhotoFile(file));
    } catch (err) {
      problems.push(`${file.name}: ${err.message}`);
    }
  }
  btn.disabled = false;
  renderPhotoStrip();
  if (problems.length > 0) showAvatarError(problems.join(' '));
}

// Downscale and re-encode before base64: an untouched 20 MB phone photo becomes a
// ~27 MB JSON body, and the model gains nothing above ~1280px.
async function processPhotoFile(file) {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `${(file.size / 1048576).toFixed(1)} MB is too large (${MAX_FILE_BYTES / 1048576} MB max).`
    );
  }
  if (file.size < MIN_FILE_BYTES) throw new Error('looks empty or corrupted.');

  // Checked by type and extension before decoding, so HEIC gets its own message
  // rather than surfacing as a generic decode failure.
  const type = (file.type || '').toLowerCase();
  if (!ALLOWED_PHOTO_TYPES.includes(type)) {
    if (type.includes('heic') || type.includes('heif') || /\.(heic|heif)$/i.test(file.name || '')) {
      throw new Error("is HEIC — Chrome can't open it. On iPhone, save it as JPG or PNG first.");
    }
    throw new Error('is not a JPG, PNG, or WebP image.');
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Chrome cannot decode HEIC/HEIF, which is the iPhone default format.
    throw new Error("could not be read — Chrome can't open HEIC photos. Export it as JPEG and retry.");
  }

  if (bitmap.width < MIN_PHOTO_DIM || bitmap.height < MIN_PHOTO_DIM) {
    bitmap.close?.();
    throw new Error(
      `is too small (${bitmap.width}x${bitmap.height}px) — use at least ${MIN_PHOTO_DIM}x${MIN_PHOTO_DIM}px.`
    );
  }
  if (Math.max(bitmap.width, bitmap.height) / Math.min(bitmap.width, bitmap.height) > MAX_PHOTO_ASPECT) {
    bitmap.close?.();
    throw new Error('looks like a banner or cropped strip, not a photo of a person.');
  }

  try {
    let encoded = null;
    for (const [maxDim, quality] of ENCODE_STEPS) {
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      encoded = { dataUrl, base64: dataUrl.split(',')[1] || '' };
      if (encoded.base64.length > 0 && encoded.base64.length <= MAX_PHOTO_B64) break;
    }

    if (!encoded || encoded.base64.length === 0) throw new Error('could not be encoded as JPEG.');
    if (encoded.base64.length > MAX_PHOTO_B64) {
      throw new Error('is too large even after downscaling — try a different photo.');
    }

    return {
      id: `photo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      dataUrl: encoded.dataUrl,
      base64: encoded.base64,
      mimeType: 'image/jpeg', // always, because we just re-encoded it
      fileName: file.name,
    };
  } finally {
    bitmap.close?.();
  }
}

function renderPhotoStrip() {
  const strip = document.getElementById('avatar-photo-strip');
  strip.innerHTML = '';
  strip.classList.toggle('hidden', avatarPhotos.length === 0);

  avatarPhotos.forEach(photo => {
    const cell = document.createElement('div');
    cell.className = 'photo-thumb';
    cell.innerHTML = `<img alt=""><button type="button" class="photo-thumb-remove" title="Remove photo" aria-label="Remove photo">✕</button>`;
    // data: URL via .src — interpolating one into innerHTML trips the extension CSP.
    const img = cell.querySelector('img');
    img.src = photo.dataUrl;
    img.alt = photo.fileName || 'Selected photo';
    cell.querySelector('.photo-thumb-remove').addEventListener('click', () => {
      avatarPhotos = avatarPhotos.filter(p => p.id !== photo.id);
      clearAvatarError();
      renderPhotoStrip();
    });
    strip.appendChild(cell);
  });

  setUploadLabel();
}

function setUploadLabel(text) {
  const el = document.getElementById('avatar-upload-text');
  if (text) {
    el.textContent = text;
    return;
  }
  const n = avatarPhotos.length;
  if (n === 0) el.textContent = `Upload a photo (up to ${MAX_PHOTOS})`;
  else if (n >= MAX_PHOTOS) el.textContent = `${n} photos — remove one to swap`;
  else if (n < RECOMMENDED_PHOTOS) el.textContent = `${n} photo — add another for a closer likeness`;
  else el.textContent = `${n} photos — add up to ${MAX_PHOTOS - n} more`;
}

function showAvatarError(message) {
  const el = document.getElementById('avatar-form-error');
  el.textContent = message;
  el.classList.remove('hidden');
}

function clearAvatarError() {
  document.getElementById('avatar-form-error').classList.add('hidden');
}

// fetch() rejects with a bare TypeError ("Failed to fetch") when the network is
// down — not a message worth putting in front of a user.
function avatarErrorText(err) {
  return err.name === 'TypeError'
    ? 'Could not reach the server — check your connection and try again.'
    : err.message;
}

// Mirrors the server's zod bounds so a typo is an inline message, not a 400.
// ── Generate ─────────────────────────────────────────────────────────────────

async function handleAvatarGenerate() {
  const btn = document.getElementById('save-avatar-btn');
  clearAvatarError();

  if (avatarPhotos.length < MIN_PHOTOS) {
    showAvatarError('Add a photo of yourself to generate your avatar.');
    return;
  }

  const totalB64 = avatarPhotos.reduce((sum, p) => sum + p.base64.length, 0);
  if (totalB64 > MAX_TOTAL_B64) {
    showAvatarError(
      `These ${avatarPhotos.length} photos are too large to send together (${(totalB64 / 1048576).toFixed(1)} MB). Remove one and try again.`
    );
    return;
  }

  avatarDraft = {
    name: document.getElementById('avatar-name').value.trim() || 'Me',
  };

  // The request can only settle or abort, and both paths leave the progress pane.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
  const startedAt = Date.now();
  const progressText = document.getElementById('avatar-progress-text');
  progressText.textContent = 'Generating 3 avatars — 0s';
  const tick = setInterval(() => {
    progressText.textContent = `Generating 3 avatars — ${Math.round((Date.now() - startedAt) / 1000)}s`;
  }, 1000);

  btn.disabled = true;
  avatarPane = 'progress';
  renderAvatarTab();

  try {
    avatarCandidates = await generateAvatarCandidates({
      photos: avatarPhotos.map(p => ({ base64: p.base64, mimeType: p.mimeType })),
      name: avatarDraft.name,
      signal: controller.signal,
    });
    selectedCandidate = avatarCandidates.length === 1 ? avatarCandidates[0].path : null;
    await storeCandidates();
    avatarPane = 'candidates';
    renderAvatarTab();
  } catch (err) {
    avatarPane = 'form';
    renderAvatarTab();
    showAvatarError(
      err.name === 'AbortError'
        ? 'Generation timed out after 3 minutes. Your photos are still selected — try again.'
        : avatarErrorText(err)
    );
  } finally {
    clearTimeout(timeoutId);
    clearInterval(tick);
    btn.disabled = false;
  }
}

// ── Candidate picker ─────────────────────────────────────────────────────────

function renderCandidateGrid() {
  const grid = document.getElementById('avatar-candidate-grid');
  const note = document.getElementById('avatar-candidate-note');
  const commitBtn = document.getElementById('avatar-commit-btn');
  grid.innerHTML = '';

  if (avatarCandidates.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon">${ICON.alert}</div>
        <h3>Nothing to choose from</h3>
        <p>Generation returned no usable avatars. Start over to try again.</p>
      </div>`;
    note.textContent = '';
    commitBtn.disabled = true;
    return;
  }

  avatarCandidates.forEach((candidate, i) => {
    const card = document.createElement('div');
    card.className = `candidate-card${selectedCandidate === candidate.path ? ' selected' : ''}`;
    card.innerHTML = `<img alt="Avatar option ${i + 1}" loading="lazy"><span class="candidate-check">✓</span>`;
    const img = card.querySelector('img');
    img.src = candidate.url;
    // A dead signed URL should look broken, not blank — the file may still be there.
    img.addEventListener('error', () => card.classList.add('candidate-broken'));
    card.addEventListener('click', () => {
      selectedCandidate = candidate.path;
      renderCandidateGrid();
    });
    grid.appendChild(card);
  });

  // Fewer than 3 means part of the cascade failed — say so rather than quietly
  // showing two and letting the user wonder.
  note.textContent = avatarCandidates.length < 3
    ? `Only ${avatarCandidates.length} of 3 avatars came back. Pick one, or start over to try for a full set.`
    : 'Only the one you pick is kept — the rest are deleted.';

  commitBtn.disabled = !selectedCandidate;
}

async function handleAvatarCommit() {
  if (!selectedCandidate) return;

  const btn = document.getElementById('avatar-commit-btn');
  const errEl = document.getElementById('avatar-candidate-error');
  errEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    avatar = await commitAvatarCandidate({
      candidatePath: selectedCandidate,
      name: avatarDraft.name,
    });
    await clearStoredCandidates();
    avatarPhotos = [];
    renderPhotoStrip();
    avatarPane = 'idle';
    renderAvatarTab();
  } catch (err) {
    // No local fabrication: if the server did not save it, the user does not have one.
    errEl.textContent = avatarErrorText(err);
    errEl.classList.remove('hidden');
    btn.disabled = false;
  } finally {
    btn.textContent = 'Use This One';
  }
}

// ── Candidate persistence ────────────────────────────────────────────────────
// Candidates live server-side under candidates/ until the next generate, so a popup
// closed mid-pick can resume instead of paying for another generation. Anything
// older than the TTL is treated as stale and dropped.

async function storeCandidates() {
  await chromeSet('local', {
    avatarCandidateDraft: {
      candidates: avatarCandidates,
      draft: avatarDraft,
      createdAt: Date.now(),
    },
  });
}

async function clearStoredCandidates() {
  avatarCandidates = [];
  selectedCandidate = null;
  await chromeSet('local', { avatarCandidateDraft: null });
}

async function restoreStoredCandidates() {
  const { avatarCandidateDraft: saved } = await chromeGet('local', ['avatarCandidateDraft']);
  if (!saved?.candidates?.length) return;
  if (Date.now() - (saved.createdAt || 0) > CANDIDATE_TTL_MS) {
    await clearStoredCandidates();
    return;
  }

  avatarCandidates = saved.candidates;
  avatarDraft = saved.draft || avatarDraft;
  selectedCandidate = null;
  document.getElementById('avatar-name').value = avatarDraft.name || '';
  avatarPane = 'candidates';
  renderAvatarTab();
}

// ── Panes ────────────────────────────────────────────────────────────────────

function renderAvatarTab() {
  const display = document.getElementById('avatar-display');
  const form = document.getElementById('avatar-form');
  const progress = document.getElementById('avatar-progress');
  const picker = document.getElementById('avatar-candidates');

  const pane = avatarPane === 'idle' ? (avatar ? 'display' : 'form') : avatarPane;
  display.classList.toggle('hidden', pane !== 'display');
  form.classList.toggle('hidden', pane !== 'form');
  progress.classList.toggle('hidden', pane !== 'progress');
  picker.classList.toggle('hidden', pane !== 'candidates');

  if (pane === 'candidates') renderCandidateGrid();
  if (pane !== 'display') return;

  // Build shell HTML first — assign the photo URL via .src to satisfy the extension CSP.
  display.innerHTML = `
    <img id="avatar-display-img" alt="Your Avatar">
    <p class="avatar-name-display">${esc(avatar.name)}</p>
    <div class="avatar-actions">
      <button class="secondary-btn" id="change-avatar-btn">Change Avatar</button>
    </div>
  `;
  document.getElementById('avatar-display-img').src = avatar.photoUrl;

  document.getElementById('change-avatar-btn').addEventListener('click', () => {
    document.getElementById('avatar-name').value = avatar.name || '';
    clearAvatarError();
    avatarPane = 'form';
    renderAvatarTab();
  });
}

// ===== TRY ON TAB =====
function setupTryOnTab() {
  document.getElementById('generate-outfit-btn').addEventListener('click', handleTryOn);

  // Drop zone — set up once here, not on every render
  const dropZone = document.getElementById('selected-outfit-items');
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const id = e.dataTransfer.getData('text/plain');
    if (id && wardrobe.find(i => i.id === id)) {
      selectedItems.add(id);
      renderTryOnTab();
    }
  });
}

function renderTryOnTab() {
  const avatarSection = document.getElementById('tryon-avatar-preview');
  const outfitSection = document.getElementById('selected-outfit-items');
  const countBadge = document.getElementById('selected-count');
  const strip = document.getElementById('tryon-wardrobe-strip');

  // Avatar preview
  if (avatar?.photoUrl) {
    avatarSection.innerHTML = `<img id="tryon-avatar-img" alt="Your Avatar">`;
    document.getElementById('tryon-avatar-img').src = avatar.photoUrl;
  } else {
    avatarSection.innerHTML = `
      <div class="empty-state" style="padding:20px">
        <div class="empty-icon">${ICON.person}</div>
        <p>No avatar yet — <a href="#" id="go-to-avatar" style="color:#000;font-weight:600">create one first</a></p>
      </div>`;
    document.getElementById('go-to-avatar')?.addEventListener('click', e => {
      e.preventDefault();
      switchTab('avatar');
    });
  }

  // Selected items as removable chips
  const selected = wardrobe.filter(i => selectedItems.has(i.id));
  countBadge.textContent = selected.length > 0 ? selected.length : '';

  outfitSection.innerHTML = '';
  if (selected.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'drop-hint';
    hint.textContent = 'Drag items here or select from Wardrobe';
    outfitSection.appendChild(hint);
  } else {
    selected.forEach(item => {
      const chip = document.createElement('span');
      chip.className = 'outfit-chip';
      chip.innerHTML = `<span>${esc(truncate(item.name, 22))}</span><button class="chip-remove" data-id="${esc(item.id)}" title="Remove">✕</button>`;
      chip.querySelector('.chip-remove').addEventListener('click', () => {
        selectedItems.delete(item.id);
        renderTryOnTab();
      });
      outfitSection.appendChild(chip);
    });
  }

  // Try-on counter
  const counter = document.getElementById('tryon-counter');
  if (counter) {
    if (profile) {
      const remaining = (profile.try_on_limit || 25) - (profile.try_on_count || 0);
      if (remaining <= 0) {
        counter.innerHTML = `No try-ons remaining. <a href="mailto:aakankshagyan3010@gmail.com?subject=Aura%20Pro%20Access" style="color:#000;font-weight:600">Join the Pro waitlist →</a>`;
        counter.className = 'tryon-counter tryon-counter--warn';
      } else {
        counter.textContent = `${remaining} of ${profile.try_on_limit} try-ons remaining`;
        counter.className = remaining <= 5 ? 'tryon-counter tryon-counter--low' : 'tryon-counter';
      }
    } else {
      counter.textContent = '';
    }
  }

  // Wardrobe drag strip
  strip.innerHTML = '';
  if (wardrobe.length === 0) {
    strip.innerHTML = `<p style="font-size:11px;color:#bbb;padding:4px 0">No wardrobe items yet</p>`;
  } else {
    wardrobe.forEach(item => {
      const thumb = document.createElement('div');
      thumb.className = `strip-thumb${selectedItems.has(item.id) ? ' selected-strip' : ''}`;
      thumb.draggable = true;
      thumb.title = item.name;
      thumb.innerHTML = `<img src="${item.imageUrl}" alt="${esc(item.name)}" onerror="this.style.display='none'"><div class="strip-thumb-name">${esc(truncate(item.name, 10))}</div>`;
      thumb.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', item.id);
        e.dataTransfer.effectAllowed = 'copy';
      });
      // Click also toggles selection
      thumb.addEventListener('click', () => {
        if (selectedItems.has(item.id)) selectedItems.delete(item.id);
        else selectedItems.add(item.id);
        renderTryOnTab();
      });
      strip.appendChild(thumb);
    });
  }
}

// ===== LOOKS TAB =====
function setupLooksTab() {
  // Nothing to bind at setup time; rendering happens on tab switch
}

async function renderLooksTab() {
  const grid = document.getElementById('looks-grid');
  const { outfits } = await chromeGet('local', ['outfits']);
  const looks = (outfits || []).slice().reverse(); // newest first

  if (looks.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon">${ICON.sparkle}</div>
        <h3>No saved looks yet</h3>
        <p>Generate a try-on and hit "Save This Look"</p>
      </div>`;
    return;
  }

  grid.innerHTML = '';
  looks.forEach(look => {
    const card = document.createElement('div');
    card.className = 'look-card';

    const img = document.createElement('img');
    img.alt = 'Saved look';
    img.src = look.generatedImageUrl;
    card.appendChild(img);

    const footer = document.createElement('div');
    footer.className = 'look-card-footer';

    const date = document.createElement('span');
    date.className = 'look-card-date';
    date.textContent = new Date(look.createdAt).toLocaleDateString();
    footer.appendChild(date);

    const del = document.createElement('button');
    del.className = 'look-delete-btn';
    del.title = 'Delete look';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      const { outfits: current } = await chromeGet('local', ['outfits']);
      await chromeSet('local', { outfits: (current || []).filter(o => o.id !== look.id) });
      card.remove();
      const remaining = grid.querySelectorAll('.look-card');
      if (remaining.length === 0) renderLooksTab();
    });
    footer.appendChild(del);

    card.appendChild(footer);
    grid.appendChild(card);
  });
}

async function handleTryOn() {
  if (!avatar) {
    switchTab('avatar');
    return;
  }

  const selected = wardrobe.filter(i => selectedItems.has(i.id));
  if (selected.length === 0) {
    switchTab('wardrobe');
    return;
  }

  // Outfit conflict detection
  const cats = selected.map(i => i.category);
  const hasDress = cats.includes('dress');
  const hasBottom = cats.includes('bottom');
  const hasTop = cats.includes('top');
  const dressCount = cats.filter(c => c === 'dress').length;

  let conflictMsg = null;
  if (hasDress && hasBottom) {
    conflictMsg = `You've selected a dress with bottoms. A dress covers the full body — adding pants underneath usually won't look right. Continue anyway?`;
  } else if (hasDress && hasTop) {
    conflictMsg = `You've selected a dress with a separate top. The top will layer over the dress which may look unintended. Continue anyway?`;
  } else if (dressCount > 1) {
    conflictMsg = `You've selected ${dressCount} dresses. Only one dress can be worn at a time. Continue with all of them?`;
  }

  if (conflictMsg && !confirm(conflictMsg)) return;

  const btn = document.getElementById('generate-outfit-btn');
  const result = document.getElementById('tryon-result');

  btn.textContent = '⏳ Generating try-on...';
  btn.disabled = true;
  result.innerHTML = '<div class="loader"><div class="spinner"></div><span>Gemini is styling your outfit...</span></div>';

  try {
    // Build clothing items array with base64
    const clothingItems = await Promise.all(selected.map(async item => {
      let base64 = item.imageBase64;
      let mimeType = item.imageMimeType || 'image/jpeg';

      if (!base64) {
        const fetched = await _sendMessageWithTimeout({ action: 'fetchImageAsBase64', url: item.imageUrl });
        if (fetched?.success) {
          base64 = fetched.data.base64;
          mimeType = fetched.data.mimeType;
        }
      }

      return {
        base64,
        mimeType,
        name: item.name,
        brand: item.brand,
        category: item.category
      };
    }));

    const validItems = clothingItems.filter(i => i.base64);
    const failedItems = selected.filter((_, i) => !clothingItems[i].base64);

    if (validItems.length === 0) {
      const names = failedItems.map(i => esc(i.name)).join(', ');
      throw new Error(`Could not load images for: ${names}. Try re-saving these items from the Detect tab.`);
    }

    const tryOnResult = await generateTryOnRemote(avatar, validItems);
    const imageUrl = tryOnResult?.imageUrl;
    const storagePath = tryOnResult?.storagePath || null;

    if (imageUrl) {
      const warningHtml = failedItems.length > 0
        ? `<p class="tryon-warning">Could not load ${failedItems.length} item(s): ${failedItems.map(i => esc(i.name)).join(', ')}. Re-save from Detect tab to include them.</p>`
        : '';

      result.innerHTML = `
        ${warningHtml}
        <img id="tryon-result-img" alt="Virtual Try-On">
        <div class="tryon-result-actions">
          <button class="secondary-btn" id="retry-tryon-btn">Try Again</button>
          <button class="secondary-btn" id="save-look-btn">Save This Look</button>
        </div>
      `;
      document.getElementById('tryon-result-img').src = imageUrl;

      document.getElementById('retry-tryon-btn').addEventListener('click', handleTryOn);

      document.getElementById('save-look-btn').addEventListener('click', async () => {
        const outfits = (await chromeGet('local', ['outfits'])).outfits || [];
        outfits.push({
          id: `outfit_${Date.now()}`,
          items: selected.map(i => i.id),
          generatedImageUrl: imageUrl,
          storagePath,
          createdAt: Date.now()
        });
        await chromeSet('local', { outfits });
        document.getElementById('save-look-btn').textContent = '✓ Saved!';
        document.getElementById('save-look-btn').disabled = true;
      });

      // Optimistic update of local counter
      if (profile) {
        profile.try_on_count = (profile.try_on_count || 0) + 1;
        renderTryOnTab();
      }
    }
  } catch (err) {
    const isLimitHit = err.message.toLowerCase().includes('limit');
    if (isLimitHit) {
      result.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">${ICON.sparkle}</div>
          <h3>Free limit reached</h3>
          <p>You've used all your free try-ons. <a href="mailto:aakankshagyan3010@gmail.com?subject=Aura%20Pro%20Access" style="color:#000;font-weight:600">Join the Pro waitlist →</a></p>
        </div>`;
      if (profile) profile.try_on_count = profile.try_on_limit;
      renderTryOnTab();
    } else {
      result.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">${ICON.alert}</div>
          <h3>Try-on failed</h3>
          <p>${esc(err.message)}</p>
          <button class="secondary-btn" id="retry-tryon-btn">Try Again</button>
        </div>`;
      document.getElementById('retry-tryon-btn')?.addEventListener('click', handleTryOn);
    }
  }

  btn.textContent = 'Generate Try-On';
  btn.disabled = false;
}

// ===== SETTINGS =====
function setupSettings() {
  const modal = document.getElementById('settings-modal');
  const backdrop = modal.querySelector('.modal-backdrop');

  document.getElementById('settings-btn').addEventListener('click', () => {
    modal.classList.remove('hidden');
  });

  const closeModal = () => modal.classList.add('hidden');
  document.getElementById('close-settings').addEventListener('click', closeModal);
  backdrop.addEventListener('click', closeModal);

  document.getElementById('sign-out-btn').addEventListener('click', async () => {
    await signOut();
    showAuthScreen();
  });
}

// ===== UTILS =====
function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
