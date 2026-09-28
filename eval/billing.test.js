// eval/billing.test.js — dependency-free node tests for the credit-pack
// payment path. Run with:  node eval/billing.test.js
//
// Everything under test is EXTRACTED FROM THE REAL SOURCE at runtime rather
// than retyped here. A retyped copy silently stops testing the shipped code
// the first time the source changes; the extraction asserts loudly if it
// stops finding what it expects.
//
// Covers: pack/price integrity (the paise-vs-rupees trap), lookup hardening,
// and Razorpay webhook signature verification.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}

function ok(label, cond) {
  check(label, !!cond, true);
}

// JSON.stringify turns a function into `undefined`, which made a truthy
// Object.prototype member print as though it were already nullish. Compare
// identity and report the real type.
function isNull(label, actual) {
  if (actual === null) passed++;
  else failures.push(`${label}\n      expected null\n      actual   ${typeof actual} (truthy: ${!!actual})`);
}

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

// ── TS extraction ────────────────────────────────────────────────────────────

// Strips the type annotations used in these files. Deliberately narrow: a
// general TS parser is not worth the dependency, and anything it fails to
// strip shows up immediately as a syntax error rather than a silent pass.
function stripTypes(src) {
  return src
    .replace(/^export\s+/gm, '')
    .replace(/:\s*Record<string,\s*Pack>/g, '')
    .replace(/:\s*Promise<boolean>/g, '')
    .replace(/:\s*Pack\s*\|\s*null/g, '')
    .replace(/:\s*ArrayBuffer/g, '')
    .replace(/:\s*unknown/g, '')
    .replace(/:\s*string/g, '')
    .replace(/:\s*boolean/g, '')
    .replace(/:\s*number/g, '');
}

// Pulls one top-level declaration out by brace matching from its opening line.
function extractBlock(src, startPattern, label) {
  const m = src.match(startPattern);
  if (!m) throw new Error(`EXTRACTION FAILED: ${label} not found — the test is not testing the real source`);
  const start = m.index;
  let i = src.indexOf('{', start);
  if (i === -1) throw new Error(`EXTRACTION FAILED: no block body for ${label}`);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`EXTRACTION FAILED: unbalanced braces for ${label}`);
}

// ── 1. Packs ─────────────────────────────────────────────────────────────────

const packsSrc = read('supabase/functions/_shared/packs.ts');
const packsSandbox = { module: {}, exports: {} };
vm.createContext(packsSandbox);
vm.runInContext(
  stripTypes(extractBlock(packsSrc, /(?:export\s+)?const PACKS/, 'PACKS')) + ';' +
  stripTypes(extractBlock(packsSrc, /(?:export\s+)?function getPack/, 'getPack')) + ';' +
  'module.exports = { PACKS, getPack };',
  packsSandbox
);
const { PACKS, getPack } = packsSandbox.module.exports;

ok('PACKS is non-empty', Object.keys(PACKS).length > 0);

for (const [id, pack] of Object.entries(PACKS)) {
  check(`${id}: id matches its key`, pack.id, id);
  ok(`${id}: credits is a positive integer`, Number.isInteger(pack.credits) && pack.credits > 0);
  ok(`${id}: amountPaise is a positive integer`, Number.isInteger(pack.amountPaise) && pack.amountPaise > 0);

  // The paise/rupees trap, in the direction that actually costs money. Razorpay
  // amounts are in the currency's smallest unit; writing 199 instead of 19900
  // charges ₹1.99 for a pack priced at ₹199, and it looks completely normal in
  // code review.
  ok(`${id}: amount is at least ₹10 (paise, not rupees)`, pack.amountPaise >= 1000);
  check(`${id}: currency is INR`, pack.currency, 'INR');
  ok(`${id}: has a human label`, typeof pack.label === 'string' && pack.label.length > 0);
}

// ── 2. Pack lookup hardening ─────────────────────────────────────────────────
//
// getPack() takes an id straight from the request body. Anything it returns is
// treated by billing/index.ts as a real pack and priced accordingly.

check('getPack: known id resolves', getPack('pack_50') && getPack('pack_50').id, 'pack_50');
isNull('getPack: unknown id is null', getPack('pack_nope'));
isNull('getPack: undefined is null', getPack(undefined));
isNull('getPack: number is null', getPack(42));
isNull('getPack: object is null', getPack({}));
isNull('getPack: empty string is null', getPack(''));

// Inherited Object.prototype members are truthy and are NOT packs. A plain
// object literal answers to every one of these.
isNull('getPack: __proto__ is null', getPack('__proto__'));
isNull('getPack: constructor is null', getPack('constructor'));
isNull('getPack: toString is null', getPack('toString'));
isNull('getPack: hasOwnProperty is null', getPack('hasOwnProperty'));
isNull('getPack: valueOf is null', getPack('valueOf'));

// ── 3. Webhook signature verification ────────────────────────────────────────

const hookSrc = read('supabase/functions/razorpay-webhook/index.ts');
const hookSandbox = { crypto, TextEncoder, module: {}, exports: {}, console };
vm.createContext(hookSandbox);
vm.runInContext(
  'const encoder = new TextEncoder();' +
  stripTypes(extractBlock(hookSrc, /function toHex/, 'toHex')) + ';' +
  stripTypes(extractBlock(hookSrc, /function timingSafeEqual/, 'timingSafeEqual')) + ';' +
  stripTypes(extractBlock(hookSrc, /async function verifySignature/, 'verifySignature')) + ';' +
  'module.exports = { toHex, timingSafeEqual, verifySignature };',
  hookSandbox
);
const { timingSafeEqual, verifySignature } = hookSandbox.module.exports;

check('timingSafeEqual: identical', timingSafeEqual('abc123', 'abc123'), true);
check('timingSafeEqual: differing last char', timingSafeEqual('abc123', 'abc124'), false);
check('timingSafeEqual: differing first char', timingSafeEqual('abc123', 'zbc123'), false);
check('timingSafeEqual: length mismatch', timingSafeEqual('abc', 'abcd'), false);
check('timingSafeEqual: both empty', timingSafeEqual('', ''), true);

const SECRET = 'whsec_test_abc123';
const BODY = JSON.stringify({
  event: 'payment_link.paid',
  payload: {
    payment_link: { entity: { id: 'plink_TEST', notes: { user_id: 'u-1', pack_id: 'pack_50' } } },
    payment: { entity: { id: 'pay_TEST' } },
  },
});

const nodeCrypto = require('crypto');
const sign = (body, secret) =>
  nodeCrypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');

(async () => {
  const good = sign(BODY, SECRET);

  check('signature: valid passes', await verifySignature(BODY, good, SECRET), true);
  check('signature: uppercase hex still passes', await verifySignature(BODY, good.toUpperCase(), SECRET), true);
  check('signature: surrounding whitespace tolerated', await verifySignature(BODY, `  ${good}\n`, SECRET), true);

  // A tampered amount is the attack this exists to stop.
  const tampered = BODY.replace('pack_50', 'pack_9999');
  check('signature: tampered body fails', await verifySignature(tampered, good, SECRET), false);

  check('signature: wrong secret fails', await verifySignature(BODY, sign(BODY, 'whsec_wrong'), SECRET), false);
  check('signature: empty signature fails', await verifySignature(BODY, '', SECRET), false);
  check('signature: truncated signature fails', await verifySignature(BODY, good.slice(0, -2), SECRET), false);
  check('signature: garbage fails', await verifySignature(BODY, 'not-a-signature', SECRET), false);

  // Byte-for-byte: re-serialising before verifying changes key order and
  // whitespace and can never match.
  const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
  check('signature: re-serialised body fails', await verifySignature(reserialised, good, SECRET), false);

  // Matches Razorpay's documented algorithm, computed independently.
  check('signature: matches independent HMAC-SHA256', await verifySignature(BODY, sign(BODY, SECRET), SECRET), true);

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.log('  FAIL  ' + f);
    process.exitCode = 1;
  }
})();
