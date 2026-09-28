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

  // ===== CATEGORISATION =====
  // Ordered rules, FIRST MATCH WINS — the order IS the precedence:
  //   dress > outerwear > shoes > bottom > top > accessory
  // The old order (top first, dress second-to-last) meant "shirt dress" matched
  // `shirt` -> top and "denim jacket" matched `denim` -> bottom. That is not
  // cosmetic: the try-on prompt maps `bottom` to "lower body only (waist to
  // feet)", so a blazer was being rendered on the legs.
  //
  // `exclude` handles the reverse direction the reorder opens up: names where
  // this rule's keyword is only a MODIFIER of a garment that ranks lower
  // ("dress shirt", "boot cut jeans", "vest top", "oxford shirt"). Anything a
  // higher rule already owns needs no exclusion here — ordering settled it.
  //
  // Every keyword is \b-anchored so "coat" does not match "coated" and "boot"
  // does not match "bootcut" — the same reasoning as the Postgres `\y`
  // boundaries in supabase/migrations/006_recategorize_items.sql. That
  // migration backfills stored rows with these same semantics; if the two ever
  // disagree an item gets one category on save and a different one on backfill.
  // Change one, change the other.
  const CATEGORY_RULES = [
    {
      category: 'dress',
      match: /\b(?:dress|dresses|sundress|sundresses|(?:maxi|midi|mini) ?dress(?:es)?|shirt ?dress(?:es)?|gown|gowns|jumpsuit|jumpsuits|playsuit|playsuits|romper|rompers|bodysuit|bodysuits|leotard|leotards|co-?ord|saree|sari|lehenga|anarkali|salwar|kurta|kurti|kaftan|caftan|abaya)\b/,
      // "dress" as an adjective ("dress shirt", "dress shorts", "dress shoes")
      // plus "dressing gown" — same set 006 refuses to guess at.
      exclude: /\bdress(?:es)?\s+(?:shirts?|blouses?|tees?|t-shirts?|tanks?|tops?|sweaters?|pants?|trousers?|shorts?|jeans?|chinos?|leggings?|skirts?|shoes?|boots?|loafers?|sandals?|heels?|socks?|belts?|watch(?:es)?|gloves?|coats?|jackets?|blazers?)\b|\bdressing ?gowns?\b/
    },
    {
      category: 'outerwear',
      match: /\b(?:jackets?|shackets?|coats?|overcoats?|trench|trenchcoats?|raincoats?|peacoats?|parkas?|windbreakers?|anoraks?|blazers?|cardigans?|bombers?|puffers?|gilets?|ponchos?|capes?|dusters?|fleeces?|vests?)\b/,
      // Outerwear word used as a modifier ("vest top", "fleece hoodie",
      // "windbreaker pants") and the sweater-vest hybrid, which reads as a top.
      // "shirt jacket"/"shacket" deliberately stays outerwear: the jacket is the
      // head noun. 006 declines to touch that pair rather than guessing.
      exclude: /\b(?:vest|fleece|jacket|coat|blazer|cardigan|bomber|trench|windbreaker|parka|puffer|cape|poncho)\s+(?:tops?|tees?|t-shirts?|tanks?|shirts?|blouses?|hoodies?|sweatshirts?|sweaters?|pullovers?|pants?|trousers?|joggers?|leggings?|shorts?|jeans?|skirts?|socks?|bags?|totes?|backpacks?)\b|\b(?:sweater|knit|knitted|cable) ?vests?\b/
    },
    {
      category: 'shoes',
      match: /\b(?:shoes?|sneakers?|trainers?|boots?|booties|bootie|sandals?|loafers?|heels?|stilettos?|pumps?|mules?|clogs?|espadrilles?|moccasins?|oxfords?|derby|derbies|brogues?|slippers?|flip.?flops?|flats|wedges|ballet ?flats?|ultraboost|air ?max|air ?force|chuck ?taylor|jordan|dunk)\b/,
      // "boot cut"/"bootleg" jeans, "boot socks", "oxford shirt" — the footwear
      // word is the fabric/cut, not the garment. 006 excludes `cut` for exactly
      // this reason. "bootcut" (unspaced) never matches at all thanks to \b.
      exclude: /\b(?:boots?|sneakers?|shoes?|loafers?|heels?|oxfords?|derby|jordan|sandals?|slippers?)\s+(?:cut|leg|socks?|shirts?|blouses?|tees?|t-shirts?|tops?|jeans?|pants?|trousers?|shorts?|skirts?|leggings?|bags?|totes?|backpacks?|dress(?:es)?)\b|\bboot.?(?:cut|leg)\b/
    },
    {
      category: 'bottom',
      match: /\b(?:pants?|jeans?|denim|skirts?|skorts?|shorts|bermudas?|trousers?|leggings?|jeggings?|chinos?|cargos?|joggers?|sweatpants?|trackpants?|track ?pants?|palazzo|culottes?|capris?|dungarees?|bootcut|boot-cut|wide.?leg|cycling ?shorts?)\b/,
      // Fabric-as-modifier: "denim shirt" is a top, "cargo tote" is a bag.
      exclude: /\b(?:denim|jeans?|cargo|chinos?)\s+(?:shirts?|blouses?|tops?|tees?|t-shirts?|tanks?|shrugs?|jackets?|blazers?|coats?|bags?|totes?|backpacks?|belts?)\b/
    },
    {
      category: 'top',
      // The vest hybrids are listed here too: the outerwear rule above excludes
      // them, and without a match of their own they would fall to accessory.
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

  const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥' };

  // Depth cap on @graph / hasVariant traversal. Real documents nest 2-3 levels;
  // the cap (plus a visited set) is what stops a self-referential document from
  // hanging the page.
  const JSONLD_MAX_DEPTH = 6;
  const JSONLD_MAX_CANDIDATES = 50;

  function formatMoney(amount, currency) {
    if (amount === undefined || amount === null || amount === '') return null;
    const sym = CURRENCY_SYMBOLS[currency] || currency || '';
    return `${sym}${amount}`;
  }

  // @type is a string on most sites but the spec allows an array ("["Product",
  // "Thing"]"), which the old string-equality check silently dropped.
  function ldTypes(node) {
    const t = node && node['@type'];
    if (!t) return [];
    return (Array.isArray(t) ? t : [t]).map(x => String(x));
  }

  function isLdProduct(node) {
    return ldTypes(node).some(t => t === 'Product' || t === 'ProductGroup' || t === 'IndividualProduct');
  }

  // Collect every Product-ish node, following the containers sites actually use
  // to wrap them. Recursive because @graph is routinely nested deeper than the
  // one level the old code checked.
  function collectLdProducts(node, depth, out, seen) {
    if (!node || depth > JSONLD_MAX_DEPTH || out.length >= JSONLD_MAX_CANDIDATES) return;
    if (Array.isArray(node)) {
      for (const n of node) collectLdProducts(n, depth + 1, out, seen);
      return;
    }
    if (typeof node !== 'object') return;
    if (seen.has(node)) return; // cyclic/shared refs
    seen.add(node);
    if (isLdProduct(node)) out.push(node);
    const containers = ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item', 'hasVariant', 'isVariantOf', 'about'];
    for (const key of containers) {
      if (node[key]) collectLdProducts(node[key], depth + 1, out, seen);
    }
  }

  // offers is a single Offer, an array of Offers, or an AggregateOffer (which
  // carries lowPrice/highPrice instead of price, and may nest the real offers).
  // Preference: exact `price` anywhere > `lowPrice`.
  function priceFromLdOffers(offers, depth) {
    const d = depth || 0;
    if (!offers || d > 4) return null;
    const list = Array.isArray(offers) ? offers : [offers];
    let low = null;
    for (const o of list) {
      if (!o || typeof o !== 'object') continue;
      const currency = o.priceCurrency || o.priceSpecification?.priceCurrency;
      const exact = o.price ?? o.priceSpecification?.price;
      if (exact !== undefined && exact !== null && exact !== '') return formatMoney(exact, currency);
      const nested = priceFromLdOffers(o.offers, d + 1);
      if (nested) return nested;
      if (low === null) low = formatMoney(o.lowPrice, currency);
    }
    return low;
  }

  // brand is a string ("brand": "Zara"), an Organization/Brand object, or an
  // array of either. Only brand.name used to be read.
  function brandFromLd(brand, depth) {
    const d = depth || 0;
    if (!brand || d > 3) return null;
    if (typeof brand === 'string') return cleanText(brand) || null;
    if (Array.isArray(brand)) {
      for (const b of brand) {
        const v = brandFromLd(b, d + 1);
        if (v) return v;
      }
      return null;
    }
    if (typeof brand === 'object') return cleanText(brand.name) || brandFromLd(brand.brand, d + 1);
    return null;
  }

  function pickLdImage(imgField) {
    let candidates = [];
    if (typeof imgField === 'string') candidates = [imgField];
    else if (Array.isArray(imgField)) candidates = imgField.map(i => typeof i === 'string' ? i : (i?.url || i?.contentUrl)).filter(Boolean);
    else if (imgField?.url) candidates = [imgField.url];
    else if (imgField?.contentUrl) candidates = [imgField.contentUrl];
    return candidates.find(u => u && !isJunkImage(u)) || candidates[0] || null;
  }

  function sameProductUrl(a, b) {
    try {
      const ua = new URL(a, b);
      const ub = new URL(b, b);
      return ua.origin === ub.origin
        && ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '');
    } catch (e) { return false; }
  }

  // A PDP frequently embeds JSON-LD for its "you may also like" rail too, and
  // returning the FIRST Product let that rail hijack detection. Prefer the node
  // that actually points at the page we are on.
  function pickLdProduct(products) {
    const named = products.filter(p => cleanText(p.name));
    if (!named.length) return null;
    const href = window.location.href;

    for (const p of named) {
      const urls = [p.url, p['@id'], p.offers?.url, p.mainEntityOfPage?.['@id'] || p.mainEntityOfPage]
        .filter(u => typeof u === 'string');
      if (urls.some(u => sameProductUrl(u, href))) return p;
    }

    const path = window.location.pathname.toLowerCase();
    for (const p of named) {
      const ids = [p.sku, p.mpn, p.productID, p.gtin13]
        .filter(v => v !== undefined && v !== null && typeof v !== 'object')
        .map(String);
      // 4+ chars so a sku like "1" does not match every URL
      if (ids.some(id => id.length >= 4 && path.includes(id.toLowerCase()))) return p;
    }

    return named[0]; // nothing points here — same result as before hardening
  }

  function extractFromJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    const candidates = [];
    const seen = new Set();
    for (const script of scripts) {
      try {
        collectLdProducts(JSON.parse(script.textContent), 0, candidates, seen);
      } catch (e) { /* malformed JSON-LD — skip this block, keep the others */ }
    }
    if (!candidates.length) return null;

    const product = pickLdProduct(candidates);
    if (!product) return null;

    const name = cleanText(product.name);
    if (!name) return null;

    // A ProductGroup holds name/brand but hangs price and images off hasVariant,
    // so read the group first and fall back to its variants field by field.
    const rawVariants = product.hasVariant;
    const variants = (Array.isArray(rawVariants) ? rawVariants : (rawVariants ? [rawVariants] : []))
      .filter(v => v && typeof v === 'object');
    const sources = [product, ...variants];

    let price = null;
    for (const s of sources) {
      price = priceFromLdOffers(s.offers, 0);
      if (price) break;
    }
    // Some sites put price/priceCurrency straight on the Product, no Offer node.
    if (!price) price = formatMoney(product.price, product.priceCurrency);

    let brand = null;
    for (const s of sources) {
      brand = brandFromLd(s.brand, 0);
      if (brand) break;
    }

    let imageUrl = null;
    for (const s of sources) {
      imageUrl = pickLdImage(s.image);
      if (imageUrl) break;
    }
    // Fall back to OG image if JSON-LD has no image
    if (!imageUrl) {
      imageUrl = document.querySelector('meta[property="og:image"]')?.content || null;
    }

    return [{
      id: `aura_jsonld_${Date.now()}`,
      name,
      brand: brand || brandFromDomain(),
      price,
      imageUrl,
      productUrl: window.location.href,
      source: getRootDomain(),
      category: categorize(name)
    }];
  }

  // ===== MICRODATA EXTRACTION (tier 1.5) =====
  // Same schema.org vocabulary as JSON-LD, expressed as itemprop attributes.
  // Only canonical schema.org/Product markup is assumed here — no site-specific
  // selectors. Before this, the DOM scan's lone [itemprop="price"] selector was
  // the extension's entire microdata awareness.

  function microdataValue(el) {
    if (!el) return null;
    const content = el.getAttribute ? el.getAttribute('content') : null;
    if (content) return cleanText(content);
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'img') return getBestSrc(el) || (el.getAttribute && el.getAttribute('src')) || null;
    if (tag === 'link' || tag === 'a') return el.getAttribute && el.getAttribute('href');
    if (tag === 'data' || tag === 'meter') return el.getAttribute && el.getAttribute('value');
    return cleanText(el.textContent);
  }

  function extractFromMicrodata() {
    let scopes = [];
    try {
      scopes = Array.from(document.querySelectorAll('[itemtype*="schema.org/Product"]'));
    } catch (e) { return null; }
    if (!scopes.length) return null;

    const excludedZones = getExcludedZones();
    for (const scope of scopes) {
      // Same guard the DOM scan uses — a "complete the look" rail can carry its
      // own Product scope.
      if (isInExcludedZone(scope, excludedZones)) continue;

      const name = cleanText(microdataValue(scope.querySelector('[itemprop="name"]')));
      if (!name || name.length < 3) continue;

      // brand is either a nested Brand/Organization scope with its own name, or
      // a bare value on the brand element itself.
      let brand = null;
      const brandEl = scope.querySelector('[itemprop="brand"]');
      if (brandEl) {
        const nested = brandEl.querySelector ? brandEl.querySelector('[itemprop="name"]') : null;
        brand = cleanText(microdataValue(nested)) || cleanText(microdataValue(brandEl));
      }

      const rawPrice = microdataValue(scope.querySelector('[itemprop="price"]'));
      const currency = microdataValue(scope.querySelector('[itemprop="priceCurrency"]')) || '';
      let price = null;
      if (rawPrice) {
        const trimmed = String(rawPrice).trim();
        // itemprop=price is usually a bare number; if it already carries a
        // symbol, extractPrice keeps the site's own formatting.
        price = /^[\d.,]+$/.test(trimmed) ? formatMoney(trimmed, currency)
                                          : (extractPrice(trimmed) || formatMoney(trimmed, currency));
      }

      let imageUrl = null;
      for (const el of Array.from(scope.querySelectorAll('[itemprop="image"]'))) {
        const v = microdataValue(el);
        if (v && !isJunkImage(v)) { imageUrl = v; break; }
      }
      if (!imageUrl) {
        imageUrl = document.querySelector('meta[property="og:image"]')?.content || null;
      }

      return [{
        id: `aura_micro_${Date.now()}`,
        name,
        brand: brand || brandFromDomain(),
        price,
        imageUrl,
        productUrl: window.location.href,
        source: getRootDomain(),
        category: categorize(name)
      }];
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
  //  1.  Try JSON-LD structured data → exact primary product, no noise
  //  1.5 Try schema.org microdata    → same vocabulary, itemprop attributes
  //  2.  Try Open Graph meta tags    → primary product, usually accurate
  //  3.  Fall back to DOM scan       → exclude recommendation zones, prefer main/article

  // Returns { tier, products } so the SPA re-check can tell "we found structured
  // data" from "we gave up and scanned the DOM".
  function detectOnce() {
    // Detect the currently active/visible gallery image (respects color swatch selection)
    const activeImage = getActiveProductImage();

    // 1. JSON-LD — most reliable for name/price/brand.
    //    Image priority (best → worst):
    //      a) MutationObserver / DOM active image  — reflects current swatch selection
    //      b) og:image meta tag                    — set by site for social sharing, always product photo
    //      c) JSON-LD image field                  — often first variant or brand logo; least reliable
    const ogImage = document.querySelector('meta[property="og:image"]')?.content;
    const ogValid = ogImage && ogImage.startsWith('http') && !isJunkImage(ogImage);

    const jsonLdResult = extractFromJsonLd();
    if (jsonLdResult) {
      jsonLdResult[0].imageUrl = activeImage || (ogValid ? ogImage : null) || jsonLdResult[0].imageUrl;
      return { tier: 'jsonld', products: jsonLdResult };
    }

    // 1.5 Microdata — same image priority as JSON-LD, for the same reasons
    const microResult = extractFromMicrodata();
    if (microResult) {
      microResult[0].imageUrl = activeImage || (ogValid ? ogImage : null) || microResult[0].imageUrl;
      return { tier: 'microdata', products: microResult };
    }

    // 2. OG meta tags — reliable for product pages, but image is static
    const metaResult = extractFromMeta();
    if (metaResult) {
      if (activeImage) metaResult[0].imageUrl = activeImage;
      return { tier: 'meta', products: metaResult };
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
    return { tier: 'dom', products: isDetailPage ? results.slice(0, 1) : results.slice(0, 12) };
  }

  function detect() {
    return detectOnce().products;
  }

  // ===== SPA TIMING =====
  // manifest.json injects at document_idle, and a client-rendered PDP often
  // writes its JSON-LD / microdata after that — we would read the DOM once, miss
  // it, and fall through to the DOM scan. So: if the first synchronous pass got
  // structured data we answer immediately (zero added latency, the common case);
  // otherwise we re-check on a short bounded poll and give up on schedule.
  //
  // A timeout chain rather than setInterval/MutationObserver: it self-terminates,
  // so there is nothing to leak if the tab navigates away mid-wait.
  const SPA_RECHECK_MAX_MS = 2000;
  // An empty DOM scan means the page has not rendered yet, so it is worth the
  // full budget. A non-empty one means we already have something to show and the
  // wait is only a chance at an upgrade — keep that short so a working site does
  // not sit on a spinner.
  const SPA_RECHECK_SHORT_MS = 600;
  const SPA_RECHECK_INTERVAL_MS = 200;

  function detectWithRetry(cb) {
    const first = detectOnce();
    if (first.tier !== 'dom') return cb(first.products);

    const budget = first.products.length ? SPA_RECHECK_SHORT_MS : SPA_RECHECK_MAX_MS;
    const deadline = Date.now() + budget;
    (function poll() {
      if (Date.now() >= deadline) return cb(detectOnce().products); // fresh scan, page has had 2s to render
      setTimeout(() => {
        const again = detectOnce();
        if (again.tier !== 'dom') return cb(again.products);
        poll();
      }, SPA_RECHECK_INTERVAL_MS);
    })();
  }

  // ===== MESSAGE LISTENER =====
  // Each injection registers its own listener but only responds if it is still
  // the current version. When a newer version injects it updates window.__auraVersion,
  // causing all older listeners to silently no-op. This avoids stale responses.
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (window.__auraVersion !== VERSION) return; // superseded — let newer listener handle it

    if (request.action === 'aura_detect') {
      // Answers asynchronously when the SPA re-check kicks in; the listener
      // already returns true below, which keeps the port open for it.
      try {
        detectWithRetry(products => {
          try { sendResponse({ products }); } catch (e) { /* port closed — popup went away */ }
        });
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

  // Test hook for eval/detection.test.js. Gated on the node runtime, not just on
  // `module`, so a page that leaks a CommonJS shim can't trip it.
  if (typeof process !== 'undefined' && process.versions?.node && typeof module !== 'undefined') {
    module.exports = {
      categorize, extractPrice, brandFromDomain,
      extractFromJsonLd, extractFromMicrodata, extractFromMeta,
      detectOnce, detect, detectWithRetry,
      priceFromLdOffers, brandFromLd, collectLdProducts, pickLdProduct
    };
  }

})();
