// eval/privacy.test.js — dependency-free static assertions that the code keeps
// the promises the published privacy policy makes. Run: node eval/privacy.test.js
//
// A privacy policy is a factual claim about what the software does. These tests
// exist so that a later edit which makes a claim false fails here rather than
// being discovered by a user or a Chrome Web Store reviewer.

const fs = require('fs');
const path = require('path');

let passed = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) passed++;
  else failures.push(label + (detail ? `\n      ${detail}` : ''));
}

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const policyPath = 'docs/index.html';
ok('privacy policy file exists', fs.existsSync(path.join(root, policyPath)),
   'the Chrome Web Store listing needs a reachable policy URL');
const policy = read(policyPath);

// ── Claim: "We do not store your original photograph" ────────────────────────

const avatar = read('supabase/functions/avatar/index.ts');
ok('policy claims the original photo is not stored', /do not store your original photograph/i.test(policy));
ok('no endpoint writes a client-supplied photo straight to storage',
   !/upload\([^)]*decode\(photoBase64\)/.test(avatar),
   'the legacy direct-save path stored the raw upload and contradicted the policy');
ok('legacy photoBase64 schema is gone', !/photoBase64/.test(avatar));
ok('only generated images reach the avatars bucket',
   /decode\(img\.base64\)/.test(avatar),
   'candidates come from the model response, not the request body');

// ── Claim: "We do not track your browsing" ───────────────────────────────────

const content = read('content.js');
ok('content script makes no network calls of its own',
   !/\bfetch\s*\(/.test(content) && !/XMLHttpRequest/.test(content),
   'a content script on <all_urls> that can phone home makes the no-tracking claim false');
ok('content script only acts when messaged',
   /chrome\.runtime\.onMessage\.addListener/.test(content) &&
   !/chrome\.runtime\.sendMessage\s*\(/.test(content),
   'it must be reactive — it reads a page only when the user clicks Scan');

// ── Claim: third parties are named exhaustively ──────────────────────────────
//
// Any host that receives user images or personal data must appear in the
// policy. This catches a new processor being added without disclosure.

const serverSrc = ['tryon', 'avatar', 'wardrobe', 'billing', 'razorpay-webhook', 'account']
  .map(f => read(`supabase/functions/${f}/index.ts`)).join('\n');

const externalHosts = [...serverSrc.matchAll(/https:\/\/([a-z0-9.-]+)/gi)]
  .map(m => m[1].toLowerCase())
  .filter(h => !h.includes('supabase.co') && !h.endsWith('deno.land'));

const DISCLOSED = { 'generativelanguage.googleapis.com': 'Google', 'fal.run': 'fal.ai', 'api.razorpay.com': 'Razorpay' };

for (const host of [...new Set(externalHosts)]) {
  const vendor = DISCLOSED[host];
  ok(`third-party host '${host}' is a disclosed processor`, !!vendor,
     'a host receiving user data with no entry here is undisclosed processing');
  if (vendor) {
    ok(`policy names ${vendor}`, new RegExp(vendor.replace('.', '\\.'), 'i').test(policy));
  }
}
ok('policy names Supabase as the storage processor', /supabase/i.test(policy));

// ── Claim: deletion works ────────────────────────────────────────────────────

const account = read('supabase/functions/account/index.ts');
ok('policy promises deletion', /delete everything/i.test(policy));
ok('a deletion endpoint exists', /DELETE/.test(account) && /deleteUser/.test(account));
ok('deletion identifies the user from the verified token, not the body',
   /supabase\.auth\.getUser\(\)/.test(account) && !/body[\s\S]{0,80}user_id/.test(account),
   'taking a user id from the request body would let anyone delete anyone');
ok('deletion purges storage as well as database rows',
   /storage[\s\S]{0,400}\.remove\(/.test(account),
   'storage has no cascade — orphaned face photos are exactly what must not survive');
// Match the CALL SITE, not the declaration. `purgeBucket(admin` also matches
// `async function purgeBucket(admin: any, ...)` at the top of the file, which
// is always before deleteUser — making this assertion trivially true.
ok('storage is purged BEFORE the auth user is deleted',
   account.indexOf('await purgeBucket(') < account.indexOf('deleteUser'),
   'deleting the user first cascades away the only record of which files were theirs');
ok('every bucket is covered',
   ['avatars', 'wardrobe-images', 'tryon-results'].every(b => account.includes(b)));

// ── Claim: consent is collected before the photo is sent ─────────────────────

const popupHtml = read('popup.html');
const popupJs = read('popup.js');

ok('a consent control exists', /id="avatar-consent"/.test(popupHtml));
ok('consent is not pre-ticked',
   !/id="avatar-consent"[^>]*checked/.test(popupHtml),
   'a pre-ticked box is not affirmative consent');
ok('the disclosure names the recipient', /Gemini/i.test(popupHtml));
ok('the disclosure links to the policy',
   /aakanksha3010\.github\.io\/aura-extension/.test(popupHtml));
ok('generation is blocked without consent',
   /avatar-consent'\)\?\.checked/.test(popupJs));

// The consent check must come before any photo leaves the browser.
const fnStart = popupJs.indexOf('async function handleAvatarGenerate');
const consentAt = popupJs.indexOf('avatar-consent', fnStart);
const sendAt = popupJs.indexOf('generateAvatarCandidates', fnStart);
ok('consent is checked before the photos are transmitted',
   consentAt !== -1 && sendAt !== -1 && consentAt < sendAt);

// ── Claim: the policy is not shipped stale ───────────────────────────────────

ok('policy states an effective date', /Effective\s+\d{1,2}\s+\w+\s+\d{4}/i.test(policy));
ok('policy gives a contact address', /mailto:[^"]+@/.test(policy));
ok('policy is excluded from the extension package',
   !read('build-extension.sh').split('FILES=(')[1].split(')')[0].includes('docs/'),
   'docs/ is a website, not extension code');

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL  ' + f);
  process.exitCode = 1;
}
