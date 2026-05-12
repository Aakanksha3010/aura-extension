// content.js — Aura product detection
// Wrapped in IIFE + version guard to prevent double-injection errors

(function () {
  const VERSION = '1.1.4';
  if (window.__auraVersion === VERSION) return;
  window.__auraVersion = VERSION;

  // Tracks the most recently detected active product image (updated by MutationObserver)
  let _activeImageSrc = null;

  // ===== HELPERS =====

  function getRootDomain() {
    const parts = window.location.hostname.replace(/^www\./, '').split('.');
    return parts.slice(-2).join('.');
  }

  function getBestSrc(img) {
    const candidates = [
      img.src,
      img.dataset.src,
      img.dataset.lazySrc,
      img.dataset.original,
      img.dataset.image,
      img.getAttribute('data-lazy'),
      img.getAttribute('data-srcset') || img.getAttribute('srcset')
    ];
    for (const c of candidates) {
      if (c && c.startsWith('http') && !c.startsWith('data:')) {
        // Take first URL from srcset if needed
        return c.split(',')[0].trim().split(' ')[0];
      }
    }
    return null;
  }

  function isJunkImage(src) {
    if (!src) return true;
    if (/logo|icon|svg|pixel|track|blank|placeholder|spinner|loading|arrow|chevron|close|menu|search|badge|flag|star|rating/i.test(src)) return true;
    // SFCC lazy-load placeholder
    if (/\/pv\.png|\/placeholder\.png|noimage/i.test(src)) return true;
    return false;
  }

  function extractPrice(text) {
    if (!text) return null;
    const patterns = [
      /₹\s*[\d,]+(?:\.\d+)?/,
      /Rs\.?\s*[\d,]+(?:\.\d+)?/i,
      /INR\s*[\d,]+(?:\.\d+)?/i,
      /[\$€£¥]\s*[\d,]+(?:\.\d+)?/,
      /MRP\s*:?\s*[\d,]+(?:\.\d+)?/i
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return m[0].trim();
    }
    return null;
  }

  function categorize(name) {
    if (!name) return 'accessory';
    const l = name.toLowerCase();
    if (/shirt|blouse|\btop\b|t-shirt|tshirt|sweater|hoodie|tee|tank|crop|bra|turtleneck|polo|button.up|button.down|sweatshirt|long.sleeve|crewneck|pullover|knitwear|knit.top|camisole|cami|tunic|henley|flannel|linen.shirt/.test(l)) return 'top';
    if (/pant|jean|denim|skirt|short|trouser|legging|chino|cargo|jogger|sweatpant|palazzo|culottes|flare|bootcut|slim.fit|straight.fit|wide.leg|trackpant|cycling.short/.test(l)) return 'bottom';
    if (/shoe|boot|sneaker|sandal|heel|loafer|flat|mule|pump|ultraboost|air.max|air.force|chuck|jordan|dunk|trainer|running.shoe|court.shoe|oxford|derby|stiletto|wedge|platform.shoe|slipper|flip.flop|espadrille/.test(l)) return 'shoes';
    if (/jacket|coat|blazer|cardigan|vest|parka|trench|overcoat|windbreaker|bomber|anorak|fleece|shacket|peacoat|duster|raincoat/.test(l)) return 'outerwear';
    if (/dress|gown|jumpsuit|romper|bodysuit|co.ord|saree|kurta|lehenga|salwar|anarkali|maxi|midi.dress|mini.dress/.test(l)) return 'dress';
    if (/bag|tote|backpack|handbag|clutch|wallet|purse|sling|crossbody|belt|scarf|hat|cap|beanie|glove|sock|sunglasses|watch|jewel|necklace|bracelet|ring|earring/.test(l)) return 'accessory';
    return 'accessory';
  }

  function cleanText(t) {
    if (!t) return '';
    return t.replace(/\s+/g, ' ').trim();
  }

  function brandFromDomain() {
    const d = getRootDomain().split('.')[0];
    return d.charAt(0).toUpperCase() + d.slice(1);
  }

  // ===== EXCLUSION HELPERS =====

  // CSS selectors for sections that contain "complete the look" / recommendations
  const RECOMMENDATION_SELECTORS = [
    '[class*="complete-the-look"]', '[class*="completelook"]', '[class*="complete_look"]',
    '[class*="look-book"]',         '[class*="lookbook"]',
    '[class*="pair-with"]',         '[class*="pairwith"]',
    '[class*="related"]',           '[class*="recommendation"]',
    '[class*="suggested"]',         '[class*="also-like"]',
    '[class*="you-may"]',           '[class*="similar"]',
    '[class*="cross-sell"]',        '[class*="upsell"]',
    '[id*="complete-the-look"]',    '[id*="related"]',
    '[id*="recommendation"]',       '[id*="suggested"]',
    '[id*="similar"]',
    'section[data-module*="look"]', 'section[data-module*="related"]'
  ].join(',');

  function getExcludedZones() {
    try {
      return Array.from(document.querySelectorAll(RECOMMENDATION_SELECTORS));
    } catch (e) {
      return [];
    }
  }

  function isInExcludedZone(el, excludedZones) {
    return excludedZones.some(zone => zone.contains(el));
  }

  // ===== STRUCTURED DATA (JSON-LD) EXTRACTION =====
  // This is the most reliable source — sites embed exact product info here.

  function extractFromJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const product = item['@type'] === 'Product' ? item
            : (item['@graph'] || []).find(n => n['@type'] === 'Product');
          if (!product) continue;

          const name = cleanText(product.name);
          if (!name) continue;

          // Price
          let price = null;
          const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
          if (offer?.price) {
            const currency = offer.priceCurrency || '';
            const symbols = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥' };
            const sym = symbols[currency] || currency;
            price = `${sym}${offer.price}`;
          }

          // Image — collect all candidates, prefer non-junk ones
          let imageUrl = null;
          const imgField = product.image;
          let imgCandidates = [];
          if (typeof imgField === 'string') imgCandidates = [imgField];
          else if (Array.isArray(imgField)) imgCandidates = imgField.map(i => typeof i === 'string' ? i : (i?.url || i?.contentUrl)).filter(Boolean);
          else if (imgField?.url) imgCandidates = [imgField.url];
          else if (imgField?.contentUrl) imgCandidates = [imgField.contentUrl];
          imageUrl = imgCandidates.find(u => u && !isJunkImage(u)) || imgCandidates[0] || null;

          // Fall back to OG image if JSON-LD has no image
          if (!imageUrl) {
            imageUrl = document.querySelector('meta[property="og:image"]')?.content || null;
          }

          return [{
            id: `aura_jsonld_${Date.now()}`,
            name,
            brand: cleanText(product.brand?.name) || brandFromDomain(),
            price,
            imageUrl,
            productUrl: window.location.href,
            source: getRootDomain(),
            category: categorize(name)
          }];
        }
      } catch (e) { /* malformed JSON-LD — skip */ }
    }
    return null;
  }

  // ===== OPEN GRAPH / META EXTRACTION =====

  function extractFromMeta() {
    const name = cleanText(document.querySelector('meta[property="og:title"]')?.content)
               || cleanText(document.querySelector('meta[name="twitter:title"]')?.content);
    if (!name || name.length < 3) return null;

    const imageUrl = document.querySelector('meta[property="og:image"]')?.content
                   || document.querySelector('meta[name="twitter:image"]')?.content;

    const priceText = document.querySelector('meta[property="product:price:amount"]')?.content
                    || document.querySelector('meta[property="og:price:amount"]')?.content;
    const currency  = document.querySelector('meta[property="product:price:currency"]')?.content || '';
    const symbols   = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥' };
    const sym       = symbols[currency] || currency;
    const price     = priceText ? `${sym}${priceText}` : null;

    // Only use OG if page looks like a product page (has price or URL pattern)
    const isProductPage = /\/(p|product|item|dp|pid)\//i.test(window.location.pathname)
                        || window.location.pathname.split('/').filter(Boolean).length >= 2;
    if (!price && !isProductPage) return null;

    return [{
      id: `aura_meta_${Date.now()}`,
      name,
      brand: brandFromDomain(),
      price,
      imageUrl: imageUrl || null,
      productUrl: window.location.href,
      source: getRootDomain(),
      category: categorize(name)
    }];
  }

  // ===== ACTIVE GALLERY IMAGE DETECTION =====
  // JSON-LD and OG meta are static — they don't change when a user picks a color swatch.
  // This function reads the currently visible/selected image from the product gallery DOM.

  function getActiveProductImage() {
    // MutationObserver captured a swatch click — most accurate
    if (_activeImageSrc) return _activeImageSrc;

    // Single pass: find the largest rendered image in the whole document.
    // Uses getBoundingClientRect() — works even for lazy-loaded images (naturalWidth=0).
    // No early-return gallery-name heuristics that can accidentally match logos.
    try {
      const excludedZones = getExcludedZones();
      const skipAncestor = el =>
        el.closest('[class*="thumb"]') || el.closest('[class*="swatch"]') ||
        el.closest('[class*="thumbnail"]') || el.closest('[class*="logo"]');

      let bestSrc = null;
      let bestArea = 0;

      for (const img of Array.from(document.querySelectorAll('img'))) {
        if (isInExcludedZone(img, excludedZones) || skipAncestor(img)) continue;
        const src = getBestSrc(img);
        if (!src || isJunkImage(src)) continue;
        const rect = img.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 200) continue;
        const area = rect.width * rect.height;
        if (area > bestArea) { bestArea = area; bestSrc = src; }
      }

      // Also check <picture><source> elements
      for (const source of Array.from(document.querySelectorAll('picture source'))) {
        const raw = source.getAttribute('srcset') || source.getAttribute('data-srcset');
        if (!raw) continue;
        const src = raw.split(',')[0].trim().split(' ')[0];
        if (!src || !src.startsWith('http') || isJunkImage(src)) continue;
        const pic = source.closest('picture');
        if (!pic || isInExcludedZone(pic, excludedZones) || skipAncestor(pic)) continue;
        const rect = pic.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 200) continue;
        const area = rect.width * rect.height;
        if (area > bestArea) { bestArea = area; bestSrc = src; }
      }

      if (bestSrc) return bestSrc;
    } catch (e) {}

    // OG / Twitter as last resort
    const ogImage = document.querySelector('meta[property="og:image"]')?.content
                 || document.querySelector('meta[property="og:image:secure_url"]')?.content
                 || document.querySelector('meta[name="twitter:image"]')?.content;
    if (ogImage && ogImage.startsWith('http') && !isJunkImage(ogImage)) return ogImage;

    return null;
  }

  // Watch the product gallery for src/class changes (color swatch clicks update the hero image)
  function observeGallery() {
    const selectors = [
      '[class*="product-gallery"]', '[class*="productGallery"]',
      '[class*="product-image"]',  '[class*="productImage"]',
      '[class*="product-photo"]',  '[class*="pdp-image"]',
      '[class*="pdp-media"]',      '[class*="product-media"]',
      '[class*="hero-image"]',     '[class*="main-image"]',
    ];
    let root = null;
    for (const sel of selectors) {
      try { root = document.querySelector(sel); if (root) break; } catch (e) {}
    }
    if (!root) return;

    const observer = new MutationObserver(() => {
      // Grab whatever image is now visible in the gallery
      const imgs = Array.from(root.querySelectorAll('img'));
      for (const img of imgs) {
        if (img.closest('[class*="thumb"]') || img.closest('[class*="swatch"]') ||
            img.closest('[class*="thumbnail"]')) continue;
        const src = getBestSrc(img);
        if (src && !isJunkImage(src)) {
          const w = img.naturalWidth  || img.width  || 0;
          const h = img.naturalHeight || img.height || 0;
          if ((w === 0 || w >= 200) && (h === 0 || h >= 200)) {
            _activeImageSrc = src;
            break;
          }
        }
      }
    });

    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'data-src', 'data-lazy', 'class'],
    });
  }

  // Start observing immediately (before user hits Scan)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observeGallery);
  } else {
    observeGallery();
  }

  // ===== MAIN DETECTION =====
  // Strategy:
  //  1. Try JSON-LD structured data  → exact primary product, no noise
  //  2. Try Open Graph meta tags     → primary product, usually accurate
  //  3. Fall back to DOM scan        → exclude recommendation zones, prefer main/article

  function detect() {
    // Detect the currently active/visible gallery image (respects color swatch selection)
    const activeImage = getActiveProductImage();

    // 1. JSON-LD — most reliable for name/price/brand.
    //    Image priority (best → worst):
    //      a) MutationObserver / DOM active image  — reflects current swatch selection
    //      b) og:image meta tag                    — set by site for social sharing, always product photo
    //      c) JSON-LD image field                  — often first variant or brand logo; least reliable
    const jsonLdResult = extractFromJsonLd();
    if (jsonLdResult) {
      const ogImage = document.querySelector('meta[property="og:image"]')?.content;
      const ogValid = ogImage && ogImage.startsWith('http') && !isJunkImage(ogImage);
      jsonLdResult[0].imageUrl = activeImage || (ogValid ? ogImage : null) || jsonLdResult[0].imageUrl;
      return jsonLdResult;
    }

    // 2. OG meta tags — reliable for product pages, but image is static
    const metaResult = extractFromMeta();
    if (metaResult) {
      if (activeImage) metaResult[0].imageUrl = activeImage;
      return metaResult;
    }

    // 3. DOM scan — restricted to non-recommendation zones
    const domain = getRootDomain();
    const results = [];
    const seenSrc = new Set();
    const excludedZones = getExcludedZones();

    // Prefer searching inside <main> or [role="main"] to avoid nav/footer noise
    const searchRoot = document.querySelector('main, [role="main"]') || document.body;
    const allImgs = Array.from(searchRoot.querySelectorAll('img'));

    allImgs.forEach((img, idx) => {
      // Skip images in recommendation/related sections
      if (isInExcludedZone(img, excludedZones)) return;

      const src = getBestSrc(img);
      if (!src || isJunkImage(src) || seenSrc.has(src)) return;

      const w = img.naturalWidth  || img.width  || parseInt(img.getAttribute('width'))  || 0;
      const h = img.naturalHeight || img.height || parseInt(img.getAttribute('height')) || 0;
      if (w > 0 && w < 120) return;
      if (h > 0 && h < 120) return;

      let name = null;
      let price = null;
      let productUrl = window.location.href;
      let container = img.parentElement;

      for (let depth = 0; depth < 6; depth++) {
        if (!container || container === document.body) break;

        if (!name) {
          const nameSelectors = [
            'h1', '[class*="product-name"]', '[class*="productName"]',
            '[class*="item-name"]', '[class*="product-title"]',
            '[data-testid*="name"]', '[data-test*="name"]',
            'h2', 'h3'
          ];
          for (const sel of nameSelectors) {
            const el = container.querySelector(sel);
            const t = cleanText(el?.textContent);
            if (t && t.length > 2 && t.length < 120 && !t.includes('|')) {
              name = t; break;
            }
          }
        }

        if (!price) {
          const priceSelectors = [
            '[class*="price"]', '[class*="amount"]', '[class*="money"]',
            '[data-testid*="price"]', '[itemprop="price"]'
          ];
          for (const sel of priceSelectors) {
            const el = container.querySelector(sel);
            const p = extractPrice(el?.textContent);
            if (p) { price = p; break; }
          }
          if (!price && container.textContent.length < 500) {
            price = extractPrice(container.textContent);
          }
        }

        const link = container.querySelector('a[href]') || (container.tagName === 'A' ? container : null);
        if (link?.href) productUrl = link.href;

        if (name) break;
        container = container.parentElement;
      }

      if (!name) {
        const alt = cleanText(img.alt);
        if (alt && alt.length > 2 && alt.length < 100) name = alt;
      }
      if (!name) {
        const title = document.title.split(/[|\-–]/)[0].trim();
        if (title.length > 2 && title.length < 100) name = title;
      }
      if (!name) return;

      seenSrc.add(src);
      results.push({
        id: `aura_${idx}_${Date.now()}`,
        name,
        brand: brandFromDomain(),
        price,
        imageUrl: src,
        productUrl,
        source: domain,
        category: categorize(name)
      });
    });

    // On a product detail page, only return the top result
    const isDetailPage = /\/(p|product|item|dp|pid)\//i.test(window.location.pathname)
                       || document.querySelector('h1') !== null;
    return isDetailPage ? results.slice(0, 1) : results.slice(0, 12);
  }

  // ===== MESSAGE LISTENER =====
  // Each injection registers its own listener but only responds if it is still
  // the current version. When a newer version injects it updates window.__auraVersion,
  // causing all older listeners to silently no-op. This avoids stale responses.
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (window.__auraVersion !== VERSION) return; // superseded — let newer listener handle it

    if (request.action === 'aura_detect') {
      try {
        sendResponse({ products: detect() });
      } catch (e) {
        sendResponse({ products: [], error: String(e) });
      }
    }

    if (request.action === 'aura_debug') {
      const ogImg = document.querySelector('meta[property="og:image"]')?.content;
      const searchRoot = document.querySelector('main, [role="main"]') || document.body;
      const imgs = Array.from(searchRoot.querySelectorAll('img')).slice(0, 30).map(img => {
        const rect = img.getBoundingClientRect();
        return {
          src: (getBestSrc(img) || img.src || '').slice(0, 120),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          junk: isJunkImage(getBestSrc(img) || ''),
          inHeader: !!(img.closest('header') || img.closest('[class*="header"]')),
        };
      });
      sendResponse({ ogImg, imgs, bgEls: [], activeImg: _activeImageSrc });
    }

    return true;
  });

})();
