// lib/gemini-service.js — Aura AI Service
//
// Image generation : Pollinations.ai (free, no extra API key)
// Photo description: gemini-2.0-flash (vision, uses user's Gemini key)
// Try-on prompt    : gemini-2.0-flash (builds rich outfit prompt from clothing images)

const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models';
const VISION_MODEL = 'gemini-2.0-flash';

async function getApiKey() {
  return new Promise(resolve =>
    chrome.storage.local.get(['geminiApiKey'], r => resolve(r.geminiApiKey || ''))
  );
}

// ===== IMAGE GENERATION via Imagen 3 (Nano Banana) =====
// Routed through background service worker so popup closing doesn't cancel it
function generateImageWithImagen3(prompt, apiKey) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'generateImagen3', prompt, apiKey }, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (response?.success) return resolve(response.dataUrl);
      reject(new Error(response?.error || 'Imagen 3 generation failed'));
    });
  });
}

// Fallback: Pollinations (free, no key needed)
function generateImageFromPrompt(prompt) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'generateImage', prompt }, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (response?.success) return resolve(response.dataUrl);
      reject(new Error(response?.error || 'Image generation failed'));
    });
  });
}

// ===== GEMINI VISION: describe user photo =====
async function describePersonFromPhoto(photoBase64, mimeType) {
  const apiKey = await getApiKey();
  if (!apiKey) return '';

  const res = await fetch(`${GEMINI_BASE}/${VISION_MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inlineData: { mimeType, data: photoBase64 } },
          { text: 'Describe this person\'s physical appearance for a fashion avatar: skin tone, hair color and style, face shape, body type. 2-3 sentences, no names.' }
        ]
      }],
      generationConfig: { maxOutputTokens: 150 }
    })
  });

  if (!res.ok) return '';
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text || '';
}

// ===== GEMINI VISION: describe a single clothing item (Step 1 of try-on) =====
async function describeClothingItem(item, apiKey) {
  // Fallback to name if no image or key
  if (!apiKey || !item.base64) return `${item.brand || ''} ${item.name}`.trim();

  try {
    const res = await fetch(`${GEMINI_BASE}/${VISION_MODEL}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType: item.mimeType || 'image/jpeg', data: item.base64 } },
            { text: 'Describe this clothing item in a short phrase. For example: "a blue floral dress" or "a brown corduroy blazer".' }
          ]
        }],
        generationConfig: { maxOutputTokens: 50 }
      })
    });
    if (!res.ok) return `${item.brand || ''} ${item.name}`.trim();
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text?.trim()
      || `${item.brand || ''} ${item.name}`.trim();
  } catch (e) {
    return `${item.brand || ''} ${item.name}`.trim();
  }
}

// ===== AVATAR GENERATION =====
// Generates a photorealistic full-body fashion avatar from user measurements.
// Photo upload is optional — if provided, it is described via Gemini vision and
// used as a style/appearance hint in the text prompt.
async function generateAvatarWithGemini(avatarData, photoBase64 = null, photoMimeType = 'image/jpeg') {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error('Avatar generation requires a Gemini API key. Please add one in Settings (⚙️).');
  }

  const bmi = avatarData.weight / ((avatarData.height / 100) ** 2);
  const bodyHint = bmi < 18.5 ? 'slim build' : bmi < 25 ? 'average build' : bmi < 30 ? 'fuller build' : 'plus size build';
  const genderWord = avatarData.gender === 'female' ? 'young woman' : avatarData.gender === 'male' ? 'young man' : 'young person';

  // If a photo was uploaded, use Gemini vision to extract an appearance description
  // (skin tone, hair, face shape) and fold it into the prompt as a style hint.
  let appearanceHint = '';
  if (photoBase64) {
    appearanceHint = await describePersonFromPhoto(photoBase64, photoMimeType);
  }

  const prompt = [
    `Photorealistic full-body fashion model photograph of a ${genderWord},`,
    `${avatarData.age} years old, ${avatarData.height}cm tall, ${bodyHint},`,
    appearanceHint ? `physical appearance: ${appearanceHint},` : '',
    `wearing a simple fitted white crew-neck top and slim neutral trousers,`,
    `standing upright facing directly forward, relaxed confident pose,`,
    `full body visible from head to toe including feet,`,
    `plain white studio background, soft even studio lighting, no harsh shadows,`,
    `hyperrealistic skin texture, sharp focus, professional fashion editorial quality,`,
    `shot on Sony A7R V, 85mm lens`
  ].filter(Boolean).join(' ');

  return await generateImageWithImagen3(prompt, apiKey);
}

// ===== VIRTUAL TRY-ON =====
// Called directly from popup context (not via background) to avoid MV3 service worker
// message port timeouts during long-running Gemini image generation requests.
async function generateOutfitWithGemini(avatar, clothingItems) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('Try-on requires a Gemini API key. Please add one in Settings (⚙️).');

  // Use the original uploaded photo for try-on (real photo preserves identity better
  // than the generated avatar). Fall back to generatedAvatarUrl if no photo stored.
  const tryOnSource = avatar.photoUrl || avatar.generatedAvatarUrl;
  let avatarBase64, avatarMimeType;
  if (tryOnSource?.startsWith('data:')) {
    avatarMimeType = tryOnSource.split(';')[0].split(':')[1];
    avatarBase64 = tryOnSource.split(',')[1];
  } else {
    throw new Error('Avatar image not available. Please re-upload your photo in the Avatar tab.');
  }

  const validItems = clothingItems.filter(i => i.base64);
  if (validItems.length === 0) throw new Error('No clothing images available. Try re-saving the items from the Detect tab.');

  // Step 1: Describe each clothing item with Gemini vision
  const descriptions = await Promise.all(
    clothingItems.map(item => describeClothingItem(item, apiKey))
  );
  const clothingDescription = descriptions.join(', ');

  // Step 2: Call Gemini image editing directly from popup context
  // (avoids background service worker being killed mid-request)
  // Key insights from reference implementations:
  //   - Text prompt must come FIRST in parts array
  //   - temperature:0.6, topP:0.95, topK:40 yields better identity/garment fidelity
  //   - Structured, explicit constraints outperform short prompts
  //   - All clothing items must be sent as separate inlineData parts so multi-item
  //     outfits (e.g. top + skirt) are each applied to the avatar

  // Map each category to its body region so Gemini knows where to apply each garment
  const bodyRegion = cat => {
    switch (cat) {
      case 'dress':     return 'FULL BODY from shoulders to feet — completely replaces both top and bottom, NO separate pants or skirt underneath';
      case 'top':       return 'upper body only (torso and arms)';
      case 'bottom':    return 'lower body only (waist to feet)';
      case 'outerwear': return 'over the full outfit as an outer layer';
      case 'shoes':     return 'feet only';
      default:          return 'as an accessory on the appropriate body part';
    }
  };

  // Build a per-item label list so the prompt can reference each image by position
  // Image 1 = avatar, Image 2..N = clothing items
  const garmentLines = validItems.map((item, i) =>
    `- Image ${i + 2}: "${descriptions[i]}" → applies to: ${bodyRegion(item.category)}`
  ).join('\n');

  const prompt = `You are performing a high-fidelity virtual try-on task.

INPUTS:
- Image 1: the person (avatar). Use ONLY for their face, skin tone, body shape, pose, hair, and accessories.
${garmentLines}

OUTPUT: A single photorealistic image of the person wearing ALL of the clothing items listed above simultaneously as a complete outfit.

ABSOLUTE CONSTRAINTS (never violate):
1. IDENTITY LOCK — preserve the person's face, features, skin tone, expression, and hair with ZERO alterations. Do not hallucinate or guess any facial details.
2. GARMENT FIDELITY — reproduce the exact color, pattern, texture, and design details of EVERY clothing item with ZERO deviations.
3. BODY REGION — apply each garment to exactly the body region specified above. A DRESS covers the full body — do NOT add pants, shorts, or any separate bottom underneath it.
4. COMPLETE OUTFIT — every garment from Images 2 onward must appear on the person. Do not omit any item.
5. POSE PRESERVATION — keep the person's exact body pose and positioning.
6. REALISTIC FIT — drape and fit each garment naturally with physically plausible folds and shadows matching the scene lighting.
7. FULL BODY — keep the full body visible head to toe.

PROHIBITIONS:
- Do NOT alter the person's face, identity, or skin tone.
- Do NOT change any garment's color, pattern, or style.
- Do NOT omit any of the provided clothing items from the output.
- Do NOT crop or cut off the person's head or feet.
- Do NOT introduce elements not present in the inputs.`;

  // Build parts array: prompt first, then avatar, then all clothing items
  const garmentParts = validItems.map(item => ({
    inlineData: { mimeType: item.mimeType || 'image/jpeg', data: item.base64 }
  }));

  // Best → fallback order for multi-image editing (try-on)
  // Gemini 2.5 Flash image models handle multi-image input+output better than Imagen
  const models = [
    'gemini-2.5-flash-preview-image-generation',
    'gemini-2.5-flash-image',
    'gemini-2.0-flash-preview-image-generation',
    'gemini-2.0-flash-exp',
  ];

  for (const model of models) {
    try {
      const res = await fetch(
        `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [
              { text: prompt },
              { inlineData: { mimeType: avatarMimeType, data: avatarBase64 } },
              ...garmentParts
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
        if (imgPart) return { dataUrl: `data:${imgPart.inlineData.mimeType || 'image/png'};base64,${imgPart.inlineData.data}`, hfFallback: false };
      }
      console.warn(`${model} failed:`, data.error?.message);
    } catch (e) {
      console.warn(`${model} error:`, e.message);
    }
  }

  // Fallback: HuggingFace IDM-VTON via background (free, but slower)
  // HF only supports a single garment image; use the first valid item
  const fallbackItem = validItems[0];
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      action: 'generateTryOn',
      avatarBase64,
      avatarMimeType,
      clothingBase64: fallbackItem.base64,
      clothingMimeType: fallbackItem.mimeType || 'image/jpeg',
      clothingDescription,
      apiKey
    }, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (response?.success) return resolve({ dataUrl: response.dataUrl, hfFallback: true });
      reject(new Error(response?.error || 'Try-on generation failed'));
    });
  });
}
