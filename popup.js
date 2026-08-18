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
    // Never leave the popup blank: surface a retryable error instead of a
    // header floating over empty white (the "blank popup" bug).
    console.error('Init failed:', err);
    showInitError(err?.message || 'Something went wrong loading Aura.');
  }
});

function hideLoading() {
  document.getElementById('loading-screen')?.classList.add('hidden');
}

function showInitError(message) {
  hideLoading();
  const screen = document.getElementById('loading-screen');
  if (!screen) return;
  screen.classList.remove('hidden');
  screen.innerHTML = `
    <div class="empty-icon">⚠️</div>
    <p class="loading-text">${esc(message)}</p>
    <button id="retry-init-btn" class="secondary-btn">↻ Retry</button>
  `;
  document.getElementById('retry-init-btn')?.addEventListener('click', () => location.reload());
}

function showAuthScreen() {
  hideLoading();
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('main-app').classList.add('hidden');
}

function showMainApp() {
  hideLoading();
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
  profile = await fetchProfile().catch(() => null);

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
    const card = document.createElement('div');
    card.className = 'product-card';
    card.innerHTML = `
      <img class="product-card-img" src="${product.imageUrl || ''}" alt="${esc(product.name)}" loading="lazy"
           onerror="this.style.display='none'">
      <div class="product-card-info">
        <p class="product-card-brand">${esc(product.brand || '')}</p>
        <p class="product-card-name">${esc(truncate(product.name, 60))}</p>
        <div class="product-card-meta">
          <span class="product-card-price">${esc(product.price || '')}</span>
          <span class="product-card-category">${esc(product.category)}</span>
        </div>
      </div>
      <button class="save-btn"></button>
    `;

    const saveBtn = card.querySelector('.save-btn');
    _renderSaveBtnState(product, saveBtn);
    container.appendChild(card);
  });
}

// Find the wardrobe entry matching a detected product (if it's been saved).
function _findSavedItem(product) {
  return wardrobe.find(
    w => w.productUrl === product.productUrl || w.name === product.name
  );
}

// Set a detect-card's action button to reflect current saved state. When saved,
// the button becomes an "undo" that removes the item from the wardrobe — so an
// unwanted detection (e.g. an imageless half of a "set") can be dropped without
// leaving the Detect view. Uses onclick so re-rendering re-wires cleanly.
function _renderSaveBtnState(product, btn) {
  const savedItem = _findSavedItem(product);
  btn.disabled = false;
  if (savedItem) {
    btn.classList.add('saved');
    btn.textContent = '✓ In Wardrobe  ✕';
    btn.title = 'Remove from wardrobe';
    btn.onclick = () => removeProduct(product, btn, savedItem.id);
  } else {
    btn.classList.remove('saved');
    btn.textContent = '＋ Save to Wardrobe';
    btn.title = '';
    btn.onclick = () => saveProduct(product, btn);
  }
}

// Remove a previously-saved detected item from the wardrobe (undo a save).
async function removeProduct(product, btn, itemId) {
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Removing...';
  try {
    await deleteWardrobeItem(itemId);
    wardrobe = wardrobe.filter(w => w.id !== itemId);
    selectedItems.delete(itemId);
    _renderSaveBtnState(product, btn); // flips back to "Save"
  } catch (err) {
    btn.disabled = false;
    btn.textContent = prev;
    console.error('Remove failed:', err.message);
  }
}

async function saveProduct(product, btn) {
  const duplicate = wardrobe.some(
    w => w.productUrl === product.productUrl || w.name === product.name
  );
  if (duplicate) {
    _renderSaveBtnState(product, btn); // shows saved state with remove option
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
    // Remove any previous error, then flip the button to the saved/remove state
    btn.parentElement?.querySelector('.save-error')?.remove();
    _renderSaveBtnState(product, btn);
  } catch (err) {
    _renderSaveBtnState(product, btn); // back to "Save" so a retry works
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
function setupAvatarTab() {
  const uploadArea = document.getElementById('avatar-upload-area');
  const uploadInput = document.getElementById('avatar-upload-input');
  const uploadPreview = document.getElementById('avatar-upload-preview');
  const uploadLabel = document.getElementById('avatar-upload-label');
  const saveBtn = document.getElementById('save-avatar-btn');

  // ── Upload validation ──────────────────────────────────────────────────────
  // A good avatar photo is what makes the try-on work, so reject anything that
  // clearly won't (wrong format, too big/tiny, low-res, banner-shaped) with a
  // specific message telling the user how to fix it, instead of silently
  // accepting a bad image and failing later at generation time.
  const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  const MAX_BYTES = 12 * 1024 * 1024; // 12 MB — server/base64 upload ceiling
  const MIN_BYTES = 5 * 1024;         // 5 KB — catch empty/corrupt files
  const MIN_DIM = 256;                // px per side — below this, try-on is poor
  const MAX_ASPECT = 2.6;             // wider/taller than this isn't a person photo

  const errEl = document.getElementById('avatar-upload-required');
  const showAvatarError = msg => {
    errEl.textContent = '⚠️ ' + msg;
    errEl.classList.remove('hidden');
  };
  const clearAvatarError = () => errEl.classList.add('hidden');
  const resetUpload = () => {
    uploadInput.value = '';
    uploadPreview.removeAttribute('src');
    uploadPreview.classList.add('hidden');
    uploadLabel.classList.remove('hidden');
  };

  uploadArea.addEventListener('click', () => uploadInput.click());

  uploadInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    clearAvatarError();

    // 1. Format — only real photo formats the model accepts.
    const type = (file.type || '').toLowerCase();
    const name = (file.name || '').toLowerCase();
    if (!ALLOWED_TYPES.includes(type)) {
      if (type.includes('heic') || type.includes('heif') || /\.(heic|heif)$/.test(name)) {
        showAvatarError('HEIC photos aren’t supported. On iPhone, save/convert the photo to JPG or PNG first.');
      } else {
        showAvatarError('Unsupported file. Please upload a JPG, PNG, or WebP image.');
      }
      resetUpload();
      return;
    }

    // 2. Size bounds.
    if (file.size > MAX_BYTES) {
      showAvatarError(`Image is too large (${(file.size / 1048576).toFixed(1)} MB). Please use one under 12 MB.`);
      resetUpload();
      return;
    }
    if (file.size < MIN_BYTES) {
      showAvatarError('That image looks empty or corrupted. Please choose another photo.');
      resetUpload();
      return;
    }

    // 3. Decode to verify it's a real image and check dimensions/shape.
    const reader = new FileReader();
    reader.onerror = () => { showAvatarError('Could not read that file. Please choose another photo.'); resetUpload(); };
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight;
        if (w < MIN_DIM || h < MIN_DIM) {
          showAvatarError(`Image is too small (${w}×${h}px). Please use at least ${MIN_DIM}×${MIN_DIM}px — a clear, full-body photo works best.`);
          resetUpload();
          return;
        }
        if (Math.max(w, h) / Math.min(w, h) > MAX_ASPECT) {
          showAvatarError('This looks like a banner or cropped strip, not a portrait. Please upload a normal photo of yourself.');
          resetUpload();
          return;
        }
        // Passed all checks — show the preview.
        uploadPreview.src = reader.result;
        uploadPreview.classList.remove('hidden');
        uploadLabel.classList.add('hidden');
      };
      img.onerror = () => { showAvatarError('That image couldn’t be decoded. Please upload a valid JPG, PNG, or WebP.'); resetUpload(); };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  saveBtn.addEventListener('click', async () => {
    const src = uploadPreview.src;
    if (!src || src === window.location.href) {
      showAvatarError('Please upload a photo to generate your avatar.');
      return;
    }
    clearAvatarError();

    const name = document.getElementById('avatar-name').value.trim() || 'Me';
    saveBtn.textContent = '⏳ Saving...';
    saveBtn.disabled = true;
    try {
      avatar = await saveAvatarRemote(name, src);
    } catch (err) {
      // Fallback: keep photo locally if upload fails
      avatar = { name, photoUrl: src, createdAt: Date.now() };
      console.error('Avatar upload failed:', err.message);
    }
    renderAvatarTab();
  });
}

function renderAvatarTab() {
  const display = document.getElementById('avatar-display');
  const form = document.getElementById('avatar-form');

  if (avatar) {
    // Build shell HTML first — assign data: URL via .src to satisfy Chrome extension CSP.
    display.innerHTML = `
      <img id="avatar-display-img" alt="Your Avatar">
      <p class="avatar-name-display">${esc(avatar.name)}</p>
      <div class="avatar-actions">
        <button class="secondary-btn" id="change-avatar-btn">Change Avatar</button>
      </div>
    `;
    document.getElementById('avatar-display-img').src = avatar.photoUrl;

    display.classList.remove('hidden');
    form.classList.add('hidden');

    document.getElementById('change-avatar-btn').addEventListener('click', () => {
      document.getElementById('avatar-name').value = avatar.name || '';
      display.classList.add('hidden');
      form.classList.remove('hidden');
    });
  } else {
    display.classList.add('hidden');
    form.classList.remove('hidden');
  }
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
          <button class="secondary-btn" id="retry-tryon-btn">↺ Try Again</button>
          <button class="secondary-btn" id="save-look-btn">💾 Save This Look</button>
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
          <div class="empty-icon">✨</div>
          <h3>Free limit reached</h3>
          <p>You've used all your free try-ons. <a href="mailto:aakankshagyan3010@gmail.com?subject=Aura%20Pro%20Access" style="color:#000;font-weight:600">Join the Pro waitlist →</a></p>
        </div>`;
      if (profile) profile.try_on_count = profile.try_on_limit;
      renderTryOnTab();
    } else {
      result.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⚠️</div>
          <h3>Try-on failed</h3>
          <p>${esc(err.message)}</p>
          <button class="secondary-btn" id="retry-tryon-btn" style="margin-top:8px">↺ Try Again</button>
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
