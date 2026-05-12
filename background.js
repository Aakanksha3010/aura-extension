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
  else if (/pant|jean|denim|skirt|short|trouser|legging|chino/.test(nl)) category = 'bottom';
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

  if (request.action === 'generateImagen3') {
    generateImagen3(request.prompt, request.apiKey)
      .then(dataUrl => sendResponse({ success: true, dataUrl }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'generateTryOn') {
    generateTryOn(request)
      .then(dataUrl => sendResponse({ success: true, dataUrl }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// ===== VIRTUAL TRY-ON =====
async function generateTryOn({ avatarBase64, avatarMimeType, clothingBase64, clothingMimeType, clothingDescription, apiKey }) {
  // 1. Try paid Gemini image editing first (if key available)
  if (apiKey) {
    const prompt = `You are performing a high-fidelity virtual try-on task.

INPUTS:
- First image: the person (avatar). Use ONLY for their face, skin tone, body shape, pose, hair, and accessories.
- Second image: the clothing item ("${clothingDescription}"). Use ONLY for the garment's color, pattern, texture, and style.

OUTPUT: A single photorealistic image of the person wearing the clothing item.

ABSOLUTE CONSTRAINTS (never violate):
1. IDENTITY LOCK — preserve the person's face, features, skin tone, expression, and hair with ZERO alterations. Do not hallucinate or guess any facial details.
2. GARMENT FIDELITY — reproduce the exact color, pattern, texture, and design details of the clothing item with ZERO deviations.
3. POSE PRESERVATION — keep the person's exact body pose and positioning.
4. REALISTIC FIT — drape and fit the garment naturally on the body with physically plausible folds and shadows matching the scene lighting.
5. FULL BODY — keep the full body visible head to toe.

PROHIBITIONS:
- Do NOT alter the person's face, identity, or skin tone.
- Do NOT change the garment's color, pattern, or style.
- Do NOT crop or cut off the person's head or feet.
- Do NOT introduce elements not present in the inputs.`;

    for (const model of ['gemini-2.0-flash-exp', 'gemini-2.5-flash-preview-image-generation', 'gemini-2.0-flash-preview-image-generation', 'gemini-2.5-flash-image']) {
      try {
        const res = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          90000,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [
                { text: prompt },
                { inlineData: { mimeType: avatarMimeType, data: avatarBase64 } },
                { inlineData: { mimeType: clothingMimeType, data: clothingBase64 } }
              ]}],
              generationConfig: {
                responseModalities: ['IMAGE', 'TEXT'],
                temperature: 0.6,
                topP: 0.95,
                topK: 40
              }
            })
          }
        );
        const data = await res.json();
        if (res.ok) {
          const imgPart = (data.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.data);
          if (imgPart) return `data:${imgPart.inlineData.mimeType || 'image/png'};base64,${imgPart.inlineData.data}`;
        }
        console.warn(`${model} failed:`, data.error?.message);
      } catch (e) { console.warn(`${model} error:`, e.message); }
    }
  }

  // 2. Free fallback: HuggingFace IDM-VTON space
  return await generateTryOnHuggingFace({ avatarBase64, avatarMimeType, clothingBase64, clothingMimeType, clothingDescription });
}

// ===== FREE TRY-ON via HuggingFace IDM-VTON =====
async function generateTryOnHuggingFace({ avatarBase64, avatarMimeType, clothingBase64, clothingMimeType, clothingDescription }) {
  const spaces = [
    'https://yisol-idm-vton.hf.space',
    'https://nymbo-virtual-try-on.hf.space'
  ];

  for (const BASE of spaces) {
    try {
      // Upload person image
      const personBlob = base64ToBlob(avatarBase64, avatarMimeType);
      const personForm = new FormData();
      personForm.append('files', personBlob, 'person.jpg');
      const personUpRes = await fetchWithTimeout(`${BASE}/upload`, 30000, { method: 'POST', body: personForm });
      if (!personUpRes.ok) throw new Error(`Person upload failed: ${personUpRes.status}`);
      const [personPath] = await personUpRes.json();

      // Upload garment image
      const garmentBlob = base64ToBlob(clothingBase64, clothingMimeType);
      const garmentForm = new FormData();
      garmentForm.append('files', garmentBlob, 'garment.jpg');
      const garmentUpRes = await fetchWithTimeout(`${BASE}/upload`, 30000, { method: 'POST', body: garmentForm });
      if (!garmentUpRes.ok) throw new Error(`Garment upload failed: ${garmentUpRes.status}`);
      const [garmentPath] = await garmentUpRes.json();

      const makeFileData = (path, name) => ({
        orig_name: name, path,
        url: `${BASE}/file=${path}`,
        meta: { _type: 'gradio.FileData' }
      });

      // Queue prediction
      const callRes = await fetchWithTimeout(`${BASE}/call/tryon`, 30000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: [
            { background: makeFileData(personPath, 'person.jpg'), layers: [], composite: null },
            makeFileData(garmentPath, 'garment.jpg'),
            clothingDescription || 'clothing item',
            true, false, 30, 42
          ]
        })
      });
      if (!callRes.ok) throw new Error(`Queue failed: ${callRes.status}`);
      const { event_id } = await callRes.json();

      // Stream SSE result
      const resultUrl = await streamHFResult(BASE, 'tryon', event_id);

      // Fetch result and convert to data URL
      const imgRes = await fetchWithTimeout(resultUrl, 30000);
      if (!imgRes.ok) throw new Error(`Result fetch failed: ${imgRes.status}`);
      return await blobToDataUrl(await imgRes.blob());

    } catch (e) {
      console.warn(`${BASE} try-on failed:`, e.message);
    }
  }

  throw new Error('Try-on failed. Free HuggingFace spaces may be temporarily unavailable. For reliable try-on, enable billing on your Gemini API key.');
}

async function streamHFResult(base, apiName, eventId, maxWait = 180000) {
  const res = await fetchWithTimeout(`${base}/call/${apiName}/${eventId}`, maxWait);
  if (!res.ok) throw new Error(`SSE stream failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastEvent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        lastEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        if (lastEvent === 'complete') {
          reader.cancel();
          const data = JSON.parse(line.slice(6));
          return data[0].url;
        } else if (lastEvent === 'error') {
          reader.cancel();
          throw new Error('HF space error: ' + line.slice(6));
        }
      }
    }
  }
  throw new Error('HuggingFace try-on timed out after 3 minutes');
}

function base64ToBlob(base64, mimeType) {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mimeType });
}

async function generateImagen3(prompt, apiKey) {
  // 1. Imagen 4 — best quality text-to-image, purpose-built for photorealistic generation
  if (apiKey) {
    for (const imagenModel of ['imagen-4.0-generate-001', 'imagen-3.0-generate-001']) {
      try {
        const res = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${imagenModel}:predict?key=${apiKey}`,
          60000,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              instances: [{ prompt }],
              parameters: { sampleCount: 1, aspectRatio: '3:4', personGeneration: 'allow_adult', safetySetting: 'block_low_and_above' }
            })
          }
        );
        const data = await res.json();
        const p = data.predictions?.[0];
        if (p?.bytesBase64Encoded) return `data:${p.mimeType || 'image/png'};base64,${p.bytesBase64Encoded}`;
        console.warn(`${imagenModel} failed:`, data.error?.message || res.status);
      } catch (e) { console.warn(`${imagenModel} error:`, e.message); }
    }

    // 2. Gemini image generation models as fallback
    for (const model of [
      'gemini-2.5-flash-image',
      'gemini-2.5-flash-preview-image-generation',
      'gemini-2.0-flash-preview-image-generation',
      'gemini-2.0-flash-exp',
    ]) {
      try {
        const res = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          60000,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
            })
          }
        );
        const data = await res.json();
        const imgPart = (data.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.data);
        if (imgPart) return `data:${imgPart.inlineData.mimeType || 'image/png'};base64,${imgPart.inlineData.data}`;
        console.warn(`${model} failed:`, data.error?.message || res.status);
      } catch (e) { console.warn(`${model} error:`, e.message); }
    }
  }

  throw new Error('Avatar generation requires a Gemini API key with billing enabled. Please add your key in Settings (⚙️) and ensure billing is active at ai.dev/projects.');
}

function fetchWithTimeout(url, ms, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

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
