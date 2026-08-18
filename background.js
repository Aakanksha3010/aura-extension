// background.js — Service worker for Aura extension

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ wardrobe: [], outfits: [] });
  chrome.storage.sync.set({ geminiApiKey: '' });

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'aura-save-image',
      title: 'Save to Aura Wardrobe',
      contexts: ['image']
    });
  });

  console.log('Aura installed.');
});

// ===== RIGHT-CLICK CONTEXT MENU =====
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'aura-save-image') return;

  const imageUrl = info.srcUrl;
  if (!imageUrl || !imageUrl.startsWith('http')) return;

  // Extract page metadata from the tab
  let name = (tab.title || 'Saved Item').split(/[|\-–]/)[0].trim();
  let pageUrl = tab.url || '';
  let source = '';

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const h1 = document.querySelector('h1')?.textContent?.trim();
        const ogTitle = document.querySelector('meta[property="og:title"]')?.content?.trim();
        const pageTitle = document.title.split(/[|\-–]/)[0].trim();
        return {
          name: h1 || ogTitle || pageTitle,
          pageUrl: window.location.href,
          source: window.location.hostname.replace(/^www\./, '')
        };
      }
    });
    if (result?.result) {
      name = result.result.name || name;
      pageUrl = result.result.pageUrl || pageUrl;
      source = result.result.source || '';
    }
  } catch (e) {
    try { source = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch (_) {}
  }

  // Guess category from name
  const nl = (name || '').toLowerCase();
  let category = 'accessory';
  if (/shirt|blouse|\btop\b|t-shirt|tshirt|sweater|hoodie|tee|tank|polo/.test(nl)) category = 'top';
  else if (/pant|jean|denim|skirt|\bshorts\b|bermuda|trouser|legging|chino/.test(nl)) category = 'bottom';
  else if (/shoe|boot|sneaker|sandal|heel|loafer|flat|pump/.test(nl)) category = 'shoes';
  else if (/jacket|coat|blazer|cardigan|vest|parka|trench/.test(nl)) category = 'outerwear';
  else if (/dress|gown|jumpsuit|romper/.test(nl)) category = 'dress';

  // Pre-fetch image as base64 (background bypasses CORS)
  let imageBase64 = null;
  let imageMimeType = 'image/jpeg';
  try {
    const imgData = await fetchImageAsBase64(imageUrl);
    imageBase64 = imgData.base64;
    imageMimeType = imgData.mimeType;
  } catch (e) {
    console.warn('Context menu: could not fetch image:', e.message);
  }

  const pendingItem = {
    id: `ctx_${Date.now()}`,
    name,
    brand: source,
    price: null,
    category,
    imageUrl,
    imageBase64,
    imageMimeType,
    productUrl: pageUrl,
    source
  };

  await chrome.storage.local.set({ pendingContextItem: pendingItem });
  chrome.action.setBadgeText({ text: '1' });
  chrome.action.setBadgeBackgroundColor({ color: '#FFD700' });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fetchImageAsBase64') {
    fetchImageAsBase64(request.url)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function fetchImageAsBase64(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const arrayBuffer = await blob.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
  return {
    base64: btoa(binary),
    mimeType: blob.type || 'image/jpeg'
  };
}
