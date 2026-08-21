// background.js — Service worker for Aura extension

// ===== CATEGORISATION =====
// !! DUPLICATED FROM content.js — KEEP IN SYNC !!
// The content script and the service worker cannot share a module without adding
// a web_accessible_resources / ES-module entry to manifest.json, so this is a
// deliberate copy. It must stay byte-identical in behaviour to CATEGORY_RULES in
// content.js and to supabase/migrations/006_recategorize_items.sql; a name that
// categorises differently depending on whether it was saved via Scan or via
// right-click is a real bug (the try-on prompt maps `bottom` to "lower body
// only", so a misfiled blazer gets rendered on the legs).
// Order IS the precedence: dress > outerwear > shoes > bottom > top > accessory.
// `exclude` catches the reverse direction — this rule's keyword used only as a
// modifier of a garment that ranks lower ("dress shirt", "boot cut jeans").
const CATEGORY_RULES = [
  {
    category: 'dress',
    match: /\b(?:dress|dresses|sundress|sundresses|(?:maxi|midi|mini) ?dress(?:es)?|shirt ?dress(?:es)?|gown|gowns|jumpsuit|jumpsuits|playsuit|playsuits|romper|rompers|bodysuit|bodysuits|leotard|leotards|co-?ord|saree|sari|lehenga|anarkali|salwar|kurta|kurti|kaftan|caftan|abaya)\b/,
    exclude: /\bdress(?:es)?\s+(?:shirts?|blouses?|tees?|t-shirts?|tanks?|tops?|sweaters?|pants?|trousers?|shorts?|jeans?|chinos?|leggings?|skirts?|shoes?|boots?|loafers?|sandals?|heels?|socks?|belts?|watch(?:es)?|gloves?|coats?|jackets?|blazers?)\b|\bdressing ?gowns?\b/
  },
  {
    category: 'outerwear',
    match: /\b(?:jackets?|shackets?|coats?|overcoats?|trench|trenchcoats?|raincoats?|peacoats?|parkas?|windbreakers?|anoraks?|blazers?|cardigans?|bombers?|puffers?|gilets?|ponchos?|capes?|dusters?|fleeces?|vests?)\b/,
    exclude: /\b(?:vest|fleece|jacket|coat|blazer|cardigan|bomber|trench|windbreaker|parka|puffer|cape|poncho)\s+(?:tops?|tees?|t-shirts?|tanks?|shirts?|blouses?|hoodies?|sweatshirts?|sweaters?|pullovers?|pants?|trousers?|joggers?|leggings?|shorts?|jeans?|skirts?|socks?|bags?|totes?|backpacks?)\b|\b(?:sweater|knit|knitted|cable) ?vests?\b/
  },
  {
    category: 'shoes',
    match: /\b(?:shoes?|sneakers?|trainers?|boots?|booties|bootie|sandals?|loafers?|heels?|stilettos?|pumps?|mules?|clogs?|espadrilles?|moccasins?|oxfords?|derby|derbies|brogues?|slippers?|flip.?flops?|flats|wedges|ballet ?flats?|ultraboost|air ?max|air ?force|chuck ?taylor|jordan|dunk)\b/,
    exclude: /\b(?:boots?|sneakers?|shoes?|loafers?|heels?|oxfords?|derby|jordan|sandals?|slippers?)\s+(?:cut|leg|socks?|shirts?|blouses?|tees?|t-shirts?|tops?|jeans?|pants?|trousers?|shorts?|skirts?|leggings?|bags?|totes?|backpacks?|dress(?:es)?)\b|\bboot.?(?:cut|leg)\b/
  },
  {
    category: 'bottom',
    match: /\b(?:pants?|jeans?|denim|skirts?|skorts?|shorts|bermudas?|trousers?|leggings?|jeggings?|chinos?|cargos?|joggers?|sweatpants?|trackpants?|track ?pants?|palazzo|culottes?|capris?|dungarees?|bootcut|boot-cut|wide.?leg|cycling ?shorts?)\b/,
    exclude: /\b(?:denim|jeans?|cargo|chinos?)\s+(?:shirts?|blouses?|tops?|tees?|t-shirts?|tanks?|shrugs?|jackets?|blazers?|coats?|bags?|totes?|backpacks?|belts?)\b/
  },
  {
    category: 'top',
    match: /\b(?:shirts?|blouses?|tops?|t-shirts?|tshirts?|tees?|sweaters?|hoodies?|sweatshirts?|tanks?|crop|cropped ?tops?|bras?|bralettes?|turtlenecks?|polos?|button.?up|button.?down|long.?sleeve|crewnecks?|pullovers?|knitwear|knit|camisoles?|cami|tunics?|henley|flannel|jerseys?|corsets?|shrugs?|(?:sweater|knit|knitted|cable) ?vests?)\b/,
    exclude: /\b(?:shirts?|tees?|t-shirts?|tops?|tanks?|polo|sweaters?|hoodies?|knit|jersey)\s+(?:bags?|totes?|backpacks?|socks?|belts?|hats?|caps?)\b/
  },
  {
    category: 'accessory',
    match: /\b(?:bags?|totes?|backpacks?|handbags?|clutch(?:es)?|wallets?|purses?|sling|crossbody|belts?|scarf|scarves|hats?|caps?|beanies?|gloves?|socks?|sunglasses|watch(?:es)?|jewel|jewellery|jewelry|necklaces?|bracelets?|rings?|earrings?|ties?|bowties?|cufflinks?)\b/
  }
];

function categorize(name) {
  if (!name) return 'accessory';
  const l = name.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.exclude && rule.exclude.test(l)) continue;
    if (rule.match.test(l)) return rule.category;
  }
  return 'accessory';
}

// Mirror of brandFromDomain() in content.js: "www.zara.com" -> "Zara".
// The context menu used to store the bare lowercase hostname as the brand, so
// items saved by right-click read "zara.com" while the same item saved by Scan
// read "Zara".
function brandFromHostname(hostname) {
  if (!hostname) return '';
  const parts = hostname.replace(/^www\./, '').split('.');
  const root = parts.slice(-2).join('.');
  const label = root.split('.')[0];
  if (!label) return '';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

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
  let brand = '';
  let price = null;

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      // Runs in the page, so it is serialised and must stay self-contained — it
      // cannot call anything defined above in this file.
      func: () => {
        const h1 = document.querySelector('h1')?.textContent?.trim();
        const ogTitle = document.querySelector('meta[property="og:title"]')?.content?.trim();
        const pageTitle = document.title.split(/[|\-–]/)[0].trim();

        const SYMBOLS = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥' };
        const money = (amount, currency) => {
          if (amount === undefined || amount === null || amount === '') return null;
          return `${SYMBOLS[currency] || currency || ''}${amount}`;
        };

        // Same tier order the content script uses: JSON-LD, then microdata,
        // then OG/product meta. Kept shallow on purpose — this runs on a
        // right-click, not on a full scan.
        let price = null;
        let brand = null;

        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          if (price && brand) break;
          try {
            const parsed = JSON.parse(s.textContent);
            const stack = [parsed];
            let guard = 0;
            while (stack.length && guard++ < 200) {
              const node = stack.pop();
              if (!node || typeof node !== 'object') continue;
              if (Array.isArray(node)) { stack.push(...node); continue; }
              for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item', 'hasVariant', 'offers']) {
                if (node[k]) stack.push(node[k]);
              }
              const types = node['@type'] ? (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]) : [];
              if (types.includes('Product') || types.includes('ProductGroup')) {
                if (!brand) {
                  const b = node.brand;
                  brand = typeof b === 'string' ? b.trim()
                        : (Array.isArray(b) ? (b[0]?.name || (typeof b[0] === 'string' ? b[0] : null)) : b?.name) || null;
                }
              }
              if (!price) {
                const exact = node.price ?? node.priceSpecification?.price;
                if (exact !== undefined && exact !== null && exact !== '') {
                  price = money(exact, node.priceCurrency || node.priceSpecification?.priceCurrency);
                } else if (node.lowPrice !== undefined && node.lowPrice !== null) {
                  price = money(node.lowPrice, node.priceCurrency);
                }
              }
            }
          } catch (e) { /* malformed JSON-LD — try the next block */ }
        }

        if (!price || !brand) {
          const scope = document.querySelector('[itemtype*="schema.org/Product"]');
          if (scope) {
            if (!price) {
              const el = scope.querySelector('[itemprop="price"]');
              const raw = el?.getAttribute('content') || el?.getAttribute('value') || el?.textContent?.trim();
              const cur = scope.querySelector('[itemprop="priceCurrency"]')?.getAttribute('content')
                       || scope.querySelector('[itemprop="priceCurrency"]')?.textContent?.trim() || '';
              if (raw) price = /^[\d.,]+$/.test(raw) ? money(raw, cur) : raw;
            }
            if (!brand) {
              const bEl = scope.querySelector('[itemprop="brand"]');
              brand = bEl?.querySelector('[itemprop="name"]')?.textContent?.trim()
                   || bEl?.getAttribute('content') || bEl?.textContent?.trim() || null;
            }
          }
        }

        if (!price) {
          const amt = document.querySelector('meta[property="product:price:amount"]')?.content
                   || document.querySelector('meta[property="og:price:amount"]')?.content;
          const cur = document.querySelector('meta[property="product:price:currency"]')?.content
                   || document.querySelector('meta[property="og:price:currency"]')?.content || '';
          if (amt) price = money(amt, cur);
        }
        if (!brand) brand = document.querySelector('meta[property="og:brand"]')?.content?.trim() || null;

        return {
          name: h1 || ogTitle || pageTitle,
          pageUrl: window.location.href,
          source: window.location.hostname.replace(/^www\./, ''),
          brand: brand || null,
          price: price || null
        };
      }
    });
    if (result?.result) {
      name = result.result.name || name;
      pageUrl = result.result.pageUrl || pageUrl;
      source = result.result.source || '';
      brand = result.result.brand || '';
      price = result.result.price || null;
    }
  } catch (e) {
    // Injection is blocked on chrome:// pages, the Web Store and some CSP'd
    // sites. Nothing readable from the page, so brand/price stay unresolved.
    try { source = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch (_) {}
  }

  // Same rules as content.js — see CATEGORY_RULES above.
  const category = categorize(name);

  // Fall back to the prettified domain, as content.js's brandFromDomain() does,
  // rather than storing the raw lowercase hostname.
  if (!brand) brand = brandFromHostname(source) || source;

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
    brand,
    // null only when the page exposed no JSON-LD / microdata / product-meta
    // price, or script injection was blocked (chrome:// pages, Web Store, some
    // CSP'd sites). Price is optional downstream, so null is a valid item.
    price,
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
