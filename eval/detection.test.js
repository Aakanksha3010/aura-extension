// eval/detection.test.js — dependency-free node tests for the Phase 2 detection
// hardening. Run with:  node eval/detection.test.js
//
// Covers categorize() ordering + every ambiguous compound named in
// supabase/migrations/006_recategorize_items.sql, the JSON-LD shapes
// extractFromJsonLd() now handles, the microdata tier, the bounded SPA
// re-check, and content.js <-> background.js categorisation parity.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadContentScript, makeEl } = require('./fake-dom');

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}

function ldScript(obj) {
  return makeEl({ tag: 'script', text: JSON.stringify(obj) });
}

// ===========================================================================
// 1. categorize()
// ===========================================================================
const aura = loadContentScript();
const cat = aura.categorize;

const CATEGORY_CASES = [
  // --- the two verified failures from the old top-first ordering -----------
  ['shirt dress', 'dress'],
  ['denim jacket', 'outerwear'],

  // --- reverse direction the reorder opens up -----------------------------
  ['dress shirt', 'top'],
  ['dress shorts', 'bottom'],
  ['dress pants', 'bottom'],
  ['dress shoes', 'shoes'],
  ['dress socks', 'accessory'],
  ['dress coat', 'outerwear'],
  // 006 excludes "dressing gown" from the dress backfill rather than guessing,
  // so we land on the shared no-match fallback. Deliberately NOT 'dress': if we
  // guessed here, a backfill would silently disagree with what we saved.
  ['dressing gown', 'accessory'],
  ['boot cut jeans', 'bottom'],
  ['bootcut jeans', 'bottom'],
  ['bootcut', 'bottom'],
  ['bootleg trousers', 'bottom'],
  ['jacket dress', 'dress'],
  ['shirt jacket', 'outerwear'],
  ['shacket', 'outerwear'],
  ['oxford shirt', 'top'],
  ['vest top', 'top'],
  ['sweater vest', 'top'],
  ['knitted vest', 'top'],
  ['cable knit vest', 'top'],
  ['fleece hoodie', 'top'],
  ['windbreaker pants', 'bottom'],
  ['denim shirt', 'top'],
  ['cargo shirt', 'top'],
  ['denim tote bag', 'accessory'],
  ['boot socks', 'accessory'],
  ['sock boots', 'shoes'],
  ['maxi skirt', 'bottom'],
  ['midi dress', 'dress'],

  // --- word boundaries, mirroring the Postgres \y in migration 006 ---------
  ['coated denim jeans', 'bottom'],   // "coat" must not match "coated"
  ['belted trench coat', 'outerwear'], // "belt" must not match "belted"
  ['bracelet', 'accessory'],           // "bra" must not match "bracelet"
  ['cropped trousers', 'bottom'],      // "crop" must not match "cropped"
  ['flat front trousers', 'bottom'],   // bare "flat" must not mean footwear

  // --- rows migration 006 explicitly repairs ------------------------------
  ['Short Blazer', 'outerwear'],
  ['Short Trench Coat', 'outerwear'],
  ['Short Boots', 'shoes'],

  // --- plain, unambiguous names must not regress --------------------------
  ['Linen Shirt', 'top'],
  ['Oversized Cotton T-Shirt', 'top'],
  ['Ribbed Tank Top', 'top'],
  ['Cashmere Sweater', 'top'],
  ['Slim Fit Chinos', 'bottom'],
  ['High Waisted Jeans', 'bottom'],
  ['Pleated Midi Skirt', 'bottom'],
  ['Cycling Shorts', 'bottom'],
  ['Wide Leg Trousers', 'bottom'],
  ['Wool Overcoat', 'outerwear'],
  ['Quilted Puffer Jacket', 'outerwear'],
  ['Puffer Vest', 'outerwear'],
  ['Nike Air Force 1', 'shoes'],
  ['Chelsea Boots', 'shoes'],
  ['Heeled Sandals', 'shoes'],
  ['Ballet Flats', 'shoes'],
  ['Floral Maxi Dress', 'dress'],
  ['Linen Jumpsuit', 'dress'],
  ['Cotton Kurta', 'dress'],
  ['Leather Tote Bag', 'accessory'],
  ['Silk Scarf', 'accessory'],
  ['Gold Hoop Earrings', 'accessory'],
  ['', 'accessory'],
  [null, 'accessory'],
  ['Mystery Object 3000', 'accessory'],
];

for (const [name, expected] of CATEGORY_CASES) {
  check(`categorize(${JSON.stringify(name)})`, cat(name), expected);
}

// ===========================================================================
// 2. content.js <-> background.js categorisation parity
// ===========================================================================
const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const bgCtx = {
  chrome: {
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
    contextMenus: { onClicked: { addListener() {} }, removeAll() {}, create() {} },
    storage: { local: { set() {} }, sync: { set() {} } },
    action: {},
  },
  console,
  URL,
};
vm.runInNewContext(bgSrc, bgCtx, { filename: 'background.js' });

const bgMismatches = CATEGORY_CASES
  .filter(([name, expected]) => bgCtx.categorize(name) !== expected)
  .map(([name]) => `${JSON.stringify(name)} -> ${bgCtx.categorize(name)}`);
check('background.js categorize() matches content.js on every case', bgMismatches, []);

// Brand parity is defined as "same answer as content.js's brandFromDomain()",
// including its two-label root-domain shortcut (which turns a .co.uk host into
// "Co"). Matching that is the point; changing it is a separate fix.
for (const host of ['www.massimodutti.com', 'zara.com', 'shop.hm.com', 'www.myntra.com', 'shop.zara.co.uk']) {
  const contentBrand = loadContentScript({ href: `https://${host}/p/x` }).brandFromDomain();
  check(`brand parity for ${host}`, bgCtx.brandFromHostname(host), contentBrand);
}
check('brandFromHostname("www.massimodutti.com")', bgCtx.brandFromHostname('www.massimodutti.com'), 'Massimodutti');
check('brandFromHostname("") is empty', bgCtx.brandFromHostname(''), '');

// ===========================================================================
// 3. extractFromJsonLd() shapes
// ===========================================================================
const PAGE = 'https://www.example.com/p/blue-shirt-dress-12345';

function jsonLd(objs, extraSelectors, href) {
  const sel = Object.assign({
    'script[type="application/ld+json"]': objs.map(o => ldScript(o)),
  }, extraSelectors || {});
  const api = loadContentScript({ href: href || PAGE, selectors: sel });
  return api.extractFromJsonLd();
}

function first(res, fields) {
  if (!res) return null;
  const out = {};
  for (const f of fields) out[f] = res[0][f];
  return out;
}

// baseline — the shape that already worked, must not regress
check('jsonld: plain Product (baseline)',
  first(jsonLd([{
    '@type': 'Product',
    name: 'Shirt Dress',
    brand: { '@type': 'Brand', name: 'Zara' },
    image: 'https://cdn.example.com/a.jpg',
    offers: { '@type': 'Offer', price: '49.90', priceCurrency: 'EUR' },
  }]), ['name', 'brand', 'price', 'imageUrl', 'category']),
  { name: 'Shirt Dress', brand: 'Zara', price: '€49.90', imageUrl: 'https://cdn.example.com/a.jpg', category: 'dress' });

check('jsonld: @type as an array',
  first(jsonLd([{
    '@type': ['Product', 'Thing'],
    name: 'Denim Jacket',
    offers: { price: '89', priceCurrency: 'USD' },
  }]), ['name', 'price', 'category']),
  { name: 'Denim Jacket', price: '$89', category: 'outerwear' });

check('jsonld: brand as a plain string',
  first(jsonLd([{ '@type': 'Product', name: 'Tee', brand: 'Zara' }]), ['brand']),
  { brand: 'Zara' });

check('jsonld: brand as an array of objects',
  first(jsonLd([{ '@type': 'Product', name: 'Tee', brand: [{ '@type': 'Brand', name: 'H&M' }] }]), ['brand']),
  { brand: 'H&M' });

check('jsonld: brand as an array of strings',
  first(jsonLd([{ '@type': 'Product', name: 'Tee', brand: ['Mango'] }]), ['brand']),
  { brand: 'Mango' });

check('jsonld: brand missing falls back to domain',
  first(jsonLd([{ '@type': 'Product', name: 'Tee' }]), ['brand']),
  { brand: 'Example' });

check('jsonld: AggregateOffer lowPrice',
  first(jsonLd([{
    '@type': 'Product',
    name: 'Wool Coat',
    offers: { '@type': 'AggregateOffer', lowPrice: '199.00', highPrice: '249.00', priceCurrency: 'GBP' },
  }]), ['price']),
  { price: '£199.00' });

check('jsonld: AggregateOffer with nested exact offers beats lowPrice',
  first(jsonLd([{
    '@type': 'Product',
    name: 'Wool Coat',
    offers: {
      '@type': 'AggregateOffer', lowPrice: '199.00', priceCurrency: 'GBP',
      offers: [{ '@type': 'Offer', price: '210.00', priceCurrency: 'GBP' }],
    },
  }]), ['price']),
  { price: '£210.00' });

check('jsonld: offers as an array',
  first(jsonLd([{
    '@type': 'Product',
    name: 'Wool Coat',
    offers: [{ '@type': 'Offer', price: '120', priceCurrency: 'INR' }],
  }]), ['price']),
  { price: '₹120' });

check('jsonld: offers array where only the second has a price',
  first(jsonLd([{
    '@type': 'Product',
    name: 'Wool Coat',
    offers: [{ '@type': 'Offer' }, { '@type': 'Offer', price: '55', priceCurrency: 'USD' }],
  }]), ['price']),
  { price: '$55' });

check('jsonld: priceSpecification',
  first(jsonLd([{
    '@type': 'Product',
    name: 'Wool Coat',
    offers: { '@type': 'Offer', priceSpecification: { price: '75', priceCurrency: 'EUR' } },
  }]), ['price']),
  { price: '€75' });

check('jsonld: ProductGroup + hasVariant supplies price and image',
  first(jsonLd([{
    '@type': 'ProductGroup',
    name: 'Shirt Dress',
    brand: 'Massimo Dutti',
    hasVariant: [{
      '@type': 'Product',
      name: 'Shirt Dress - Blue',
      image: ['https://cdn.example.com/blue.jpg'],
      offers: { '@type': 'Offer', price: '79.95', priceCurrency: 'EUR' },
    }],
  }]), ['name', 'brand', 'price', 'imageUrl', 'category']),
  { name: 'Shirt Dress', brand: 'Massimo Dutti', price: '€79.95', imageUrl: 'https://cdn.example.com/blue.jpg', category: 'dress' });

check('jsonld: @graph nested three levels deep',
  first(jsonLd([{
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', mainEntity: { '@graph': [{ '@type': 'Product', name: 'Deep Blazer' }] } },
    ],
  }]), ['name', 'category']),
  { name: 'Deep Blazer', category: 'outerwear' });

check('jsonld: prefers the Product whose url matches the page',
  first(jsonLd([{
    '@graph': [
      { '@type': 'Product', name: 'Related Sneakers', url: 'https://www.example.com/p/other-999' },
      { '@type': 'Product', name: 'Blue Shirt Dress', url: PAGE },
    ],
  }]), ['name', 'category']),
  { name: 'Blue Shirt Dress', category: 'dress' });

check('jsonld: url match ignores query string and trailing slash',
  first(jsonLd([{
    '@graph': [
      { '@type': 'Product', name: 'Related Sneakers', url: 'https://www.example.com/p/other-999' },
      { '@type': 'Product', name: 'Blue Shirt Dress', url: PAGE + '/?color=blue#gallery' },
    ],
  }]), ['name']),
  { name: 'Blue Shirt Dress' });

check('jsonld: falls back to sku present in the path',
  first(jsonLd([{
    '@graph': [
      { '@type': 'Product', name: 'Related Sneakers', sku: '99999' },
      { '@type': 'Product', name: 'Blue Shirt Dress', sku: '12345' },
    ],
  }]), ['name']),
  { name: 'Blue Shirt Dress' });

check('jsonld: falls back to the first Product when nothing points at the page',
  first(jsonLd([{ '@graph': [
    { '@type': 'Product', name: 'First Product' },
    { '@type': 'Product', name: 'Second Product' },
  ] }]), ['name']),
  { name: 'First Product' });

check('jsonld: a malformed block does not kill a later valid one',
  (() => {
    const api = loadContentScript({
      href: PAGE,
      selectors: {
        'script[type="application/ld+json"]': [
          makeEl({ tag: 'script', text: '{ not json' }),
          ldScript({ '@type': 'Product', name: 'Survivor Coat' }),
        ],
      },
    });
    return first(api.extractFromJsonLd(), ['name', 'category']);
  })(),
  { name: 'Survivor Coat', category: 'outerwear' });

check('jsonld: cyclic @graph terminates instead of hanging',
  (() => {
    const a = { '@type': 'WebPage' };
    a['@graph'] = [a, { '@type': 'Product', name: 'Cyclic Tee' }];
    const api = loadContentScript({
      href: PAGE,
      selectors: { 'script[type="application/ld+json"]': [makeEl({ tag: 'script', text: JSON.stringify(a, cycleSafe()) })] },
    });
    return first(api.extractFromJsonLd(), ['name']);
  })(),
  { name: 'Cyclic Tee' });

function cycleSafe() {
  const seen = new WeakSet();
  return (k, v) => {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return undefined;
      seen.add(v);
    }
    return v;
  };
}

check('jsonld: no Product node at all returns null',
  jsonLd([{ '@type': 'Organization', name: 'Example Inc' }]),
  null);

check('jsonld: falls back to og:image when the Product has none',
  first(jsonLd([{ '@type': 'Product', name: 'Tee' }], {
    'meta[property="og:image"]': [makeEl({ tag: 'meta', content: 'https://cdn.example.com/og.jpg' })],
  }), ['imageUrl']),
  { imageUrl: 'https://cdn.example.com/og.jpg' });

check('jsonld: skips a logo image in favour of a real one',
  first(jsonLd([{ '@type': 'Product', name: 'Tee', image: ['https://cdn.example.com/logo.png', 'https://cdn.example.com/real.jpg'] }]), ['imageUrl']),
  { imageUrl: 'https://cdn.example.com/real.jpg' });

// ===========================================================================
// 4. extractFromMicrodata()
// ===========================================================================
function microScope(props) {
  const sel = {};
  for (const [k, v] of Object.entries(props)) sel[k] = Array.isArray(v) ? v : [v];
  return makeEl({ tag: 'div', attrs: { itemtype: 'https://schema.org/Product' }, sel });
}

check('microdata: name/brand/price/image',
  (() => {
    const brandEl = makeEl({
      tag: 'span', attrs: { itemprop: 'brand' },
      sel: { '[itemprop="name"]': [makeEl({ tag: 'span', text: 'Massimo Dutti' })] },
    });
    const scope = microScope({
      '[itemprop="name"]': makeEl({ tag: 'h1', text: '  Wool   Blazer ' }),
      '[itemprop="brand"]': brandEl,
      '[itemprop="price"]': makeEl({ tag: 'meta', content: '149.00' }),
      '[itemprop="priceCurrency"]': makeEl({ tag: 'meta', content: 'EUR' }),
      '[itemprop="image"]': makeEl({ tag: 'img', src: 'https://cdn.example.com/blazer.jpg' }),
    });
    const api = loadContentScript({
      href: PAGE,
      selectors: { '[itemtype*="schema.org/Product"]': [scope] },
    });
    return first(api.extractFromMicrodata(), ['name', 'brand', 'price', 'imageUrl', 'category']);
  })(),
  { name: 'Wool Blazer', brand: 'Massimo Dutti', price: '€149.00', imageUrl: 'https://cdn.example.com/blazer.jpg', category: 'outerwear' });

check('microdata: brand as a bare value, price already carrying a symbol',
  (() => {
    const scope = microScope({
      '[itemprop="name"]': makeEl({ tag: 'h1', text: 'Boot Cut Jeans' }),
      '[itemprop="brand"]': makeEl({ tag: 'span', text: 'Levi' }),
      '[itemprop="price"]': makeEl({ tag: 'span', text: '₹2,499' }),
    });
    const api = loadContentScript({ href: PAGE, selectors: { '[itemtype*="schema.org/Product"]': [scope] } });
    return first(api.extractFromMicrodata(), ['name', 'brand', 'price', 'category']);
  })(),
  { name: 'Boot Cut Jeans', brand: 'Levi', price: '₹2,499', category: 'bottom' });

check('microdata: skips a junk image and takes the next',
  (() => {
    const scope = microScope({
      '[itemprop="name"]': makeEl({ tag: 'h1', text: 'Linen Shirt' }),
      '[itemprop="image"]': [
        makeEl({ tag: 'img', src: 'https://cdn.example.com/site-logo.png' }),
        makeEl({ tag: 'img', src: 'https://cdn.example.com/shirt.jpg' }),
      ],
    });
    const api = loadContentScript({ href: PAGE, selectors: { '[itemtype*="schema.org/Product"]': [scope] } });
    return first(api.extractFromMicrodata(), ['imageUrl']);
  })(),
  { imageUrl: 'https://cdn.example.com/shirt.jpg' });

check('microdata: no Product scope returns null',
  loadContentScript({ href: PAGE, selectors: {} }).extractFromMicrodata(),
  null);

check('microdata: scope with no usable name returns null',
  (() => {
    const scope = microScope({ '[itemprop="price"]': makeEl({ tag: 'meta', content: '10' }) });
    const api = loadContentScript({ href: PAGE, selectors: { '[itemtype*="schema.org/Product"]': [scope] } });
    return api.extractFromMicrodata();
  })(),
  null);

// ===========================================================================
// 5. Tier ordering + bounded SPA re-check
// ===========================================================================
check('detectOnce: JSON-LD wins over microdata',
  (() => {
    const scope = microScope({ '[itemprop="name"]': makeEl({ tag: 'h1', text: 'Microdata Coat' }) });
    const api = loadContentScript({
      href: PAGE,
      selectors: {
        'script[type="application/ld+json"]': [ldScript({ '@type': 'Product', name: 'JsonLd Coat' })],
        '[itemtype*="schema.org/Product"]': [scope],
      },
    });
    const r = api.detectOnce();
    return [r.tier, r.products[0].name];
  })(),
  ['jsonld', 'JsonLd Coat']);

check('detectOnce: microdata wins over og:title',
  (() => {
    const scope = microScope({ '[itemprop="name"]': makeEl({ tag: 'h1', text: 'Microdata Coat' }) });
    const api = loadContentScript({
      href: PAGE,
      selectors: {
        '[itemtype*="schema.org/Product"]': [scope],
        'meta[property="og:title"]': [makeEl({ tag: 'meta', content: 'OG Coat' })],
      },
    });
    const r = api.detectOnce();
    return [r.tier, r.products[0].name];
  })(),
  ['microdata', 'Microdata Coat']);

// Async tests run last so the sync report is already assembled.
const asyncTests = [];

asyncTests.push(() => new Promise(resolve => {
  const api = loadContentScript({
    href: PAGE,
    selectors: { 'script[type="application/ld+json"]': [ldScript({ '@type': 'Product', name: 'Instant Tee' })] },
  });
  const t0 = Date.now();
  api.detectWithRetry(products => {
    const dt = Date.now() - t0;
    check('spa: structured data present answers synchronously (<50ms)', [products[0].name, dt < 50], ['Instant Tee', true]);
    resolve();
  });
}));

asyncTests.push(() => new Promise(resolve => {
  // Nothing structured at first; JSON-LD is injected ~300ms in, as a client-
  // rendered PDP would. Must be picked up without waiting out the full budget.
  const api = loadContentScript({ href: PAGE, selectors: {} });
  const doc = global.document;
  setTimeout(() => doc.__set('script[type="application/ld+json"]', [ldScript({ '@type': 'Product', name: 'Late Hydrated Dress' })]), 300);
  const t0 = Date.now();
  api.detectWithRetry(products => {
    const dt = Date.now() - t0;
    check('spa: late JSON-LD is picked up, and before the 2s budget',
      [products[0] && products[0].name, dt >= 250 && dt < 1200], ['Late Hydrated Dress', true]);
    resolve();
  });
}));

asyncTests.push(() => new Promise(resolve => {
  // Nothing ever appears — must give up on schedule, not hang.
  const api = loadContentScript({ href: PAGE, selectors: {} });
  const t0 = Date.now();
  api.detectWithRetry(products => {
    const dt = Date.now() - t0;
    check('spa: gives up within the bounded window and returns the DOM scan',
      [Array.isArray(products), dt >= 1900 && dt < 3200], [true, true]);
    resolve();
  });
}));

(async () => {
  for (const t of asyncTests) await t();

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.log('  FAIL  ' + f);
    process.exitCode = 1;
  }
})();
