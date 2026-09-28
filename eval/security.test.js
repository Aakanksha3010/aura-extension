// eval/security.test.js — dependency-free static assertions over the SQL and
// edge-function sources. Run with:  node eval/security.test.js
//
// These guard invariants that no functional test can reach, because breaking
// them produces code that still works perfectly — it just leaks money or data.
// Each assertion below corresponds to a defect that was actually present in
// this repo, or to one a plausible edit would reintroduce.

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
const migrationsDir = path.join(root, 'supabase/migrations');
const migrations = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
const allSql = migrations.map(f => fs.readFileSync(path.join(migrationsDir, f), 'utf8')).join('\n');

// ── 1. Every SECURITY DEFINER function must have EXECUTE revoked ─────────────
//
// Postgres grants EXECUTE on new functions to PUBLIC by default. A security
// definer function runs with the owner's rights, so leaving the default in
// place publishes it to every anon and authenticated caller. refund_try_on is
// the sharp case: exposed, it is an unlimited free-credit generator.

// Migrations are CREATE OR REPLACE and run in order, so only the LAST
// definition of a name describes the live database. Checking every match
// would flag a definition that a later migration already fixed — 001's
// handle_new_user is exactly that case, superseded by 005.
const definerFns = new Map();
for (const file of migrations) {
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(([^)]*)\)/gi)) {
    // Body runs to the closing $$ of the definition, not a fixed window.
    const from = m.index;
    const bodyEnd = sql.indexOf('$$;', sql.indexOf('$$', from) + 2);
    const body = sql.slice(from, bodyEnd === -1 ? from + 3000 : bodyEnd + 3);
    definerFns.set(m[1].toLowerCase(), {
      name: m[1],
      file,
      body,
      isDefiner: /security\s+definer/i.test(body),
      isTrigger: /returns\s+trigger/i.test(body),
    });
  }
}

const liveDefiners = [...definerFns.values()].filter(f => f.isDefiner);
ok('found SECURITY DEFINER functions to check', liveDefiners.length > 0,
   'none found — this test would pass vacuously');

for (const fn of liveDefiners) {
  // A security definer function that resolves objects through the CALLER's
  // search_path can be pointed at a shadowed table. Required for all of them,
  // trigger or not.
  ok(`SECURITY DEFINER ${fn.name}() pins search_path (${fn.file})`,
     /set\s+search_path/i.test(fn.body));

  // Postgres refuses to invoke a trigger function directly, so the default
  // PUBLIC grant is not reachable for those. For everything else the revoke
  // is what keeps it off the client: refund_try_on, exposed, is an unlimited
  // free-credit generator.
  if (fn.isTrigger) {
    passed++;
    continue;
  }
  const revoked = new RegExp(
    `revoke\\s+all\\s+on\\s+function\\s+${fn.name}\\s*\\([^)]*\\)\\s+from\\s+[^;]*public`, 'i'
  ).test(allSql);
  ok(`SECURITY DEFINER ${fn.name}() has EXECUTE revoked from public`, revoked,
     'without this it is callable directly by any signed-in user');
}

// ── 2. Quota columns are not client-writable ─────────────────────────────────
//
// RLS is row-level only. "own profile" FOR ALL USING (auth.uid() = id) lets a
// user PATCH any column of their own row, including try_on_limit.

ok('UPDATE on profiles is revoked from authenticated',
   /revoke\s+update\s+on\s+profiles\s+from[^;]*authenticated/i.test(allSql),
   'without this a user can PATCH their own try_on_limit and mint unlimited try-ons');

const grantMatch = allSql.match(/grant\s+update\s*\(([^)]*)\)\s*on\s+profiles\s+to\s+authenticated/i);
ok('profiles UPDATE is re-granted only column-wise', !!grantMatch);
if (grantMatch) {
  const cols = grantMatch[1].split(',').map(c => c.trim().toLowerCase());
  for (const forbidden of ['try_on_limit', 'try_on_count', 'tier', 'id', 'email']) {
    ok(`profiles: '${forbidden}' is NOT client-writable`, !cols.includes(forbidden));
  }
}

// ── 3. payments is read-only to clients ──────────────────────────────────────

const packSql = read('supabase/migrations/009_credit_packs.sql');
ok('payments has RLS enabled', /alter\s+table\s+payments\s+enable\s+row\s+level\s+security/i.test(packSql));

const paymentPolicies = [...packSql.matchAll(/create\s+policy\s+"[^"]+"\s+on\s+payments\s+for\s+(\w+)/gi)]
  .map(m => m[1].toLowerCase());
ok('payments has at least one policy', paymentPolicies.length > 0);
ok('payments policies are SELECT-only',
   paymentPolicies.every(p => p === 'select'),
   `found: ${paymentPolicies.join(', ')} — a client-writable payments row is a self-granted credit pack`);

ok('payments link id is unique (webhook idempotency)',
   /razorpay_payment_link_id\s+text\s+not\s+null\s+unique/i.test(packSql),
   'without UNIQUE, a retried webhook delivery inserts a second row and grants twice');

ok('credit grant is guarded by credits_granted_at',
   /credits_granted_at\s+is\s+null/i.test(packSql),
   'the guard must be inside the UPDATE, not a read-then-write in the edge function');

// ── 4. The server owns the price ─────────────────────────────────────────────

const billing = read('supabase/functions/billing/index.ts');
const webhook = read('supabase/functions/razorpay-webhook/index.ts');

// The request schema must not accept anything money-shaped.
const createSchema = billing.match(/const CreateSchema = z\.object\(\{([\s\S]*?)\}\)/);
ok('billing CreateSchema exists', !!createSchema);
if (createSchema) {
  for (const field of ['amount', 'price', 'credits', 'currency']) {
    ok(`billing does not accept '${field}' from the client`,
       !new RegExp(`\\b${field}\\b`, 'i').test(createSchema[1]),
       'a client-supplied price lets anyone buy a pack for ₹1');
  }
}

ok('billing takes amount from PACKS', /amount:\s*pack\.amountPaise/.test(billing));
ok('billing imports the shared pack table', /from '\.\.\/_shared\/packs\.ts'/.test(billing));

ok('webhook re-derives credits from PACKS, not the payload',
   /credits:\s*pack\.credits/.test(webhook),
   'reading credits from the webhook body lets a valid signature over tampered notes mint credits');
ok('webhook re-derives amount from PACKS, not the payload',
   /amount_paise:\s*pack\.amountPaise/.test(webhook));

// ── 5. Webhook authenticates ─────────────────────────────────────────────────

ok('webhook reads the documented signature header',
   /X-Razorpay-Signature/i.test(webhook));
ok('webhook verifies over the RAW body',
   /await req\.text\(\)/.test(webhook) && !/await req\.json\(\)/.test(webhook),
   'parsing before verifying changes key order and whitespace, so the HMAC can never match');
ok('webhook rejects an unverified body',
   /verifySignature[\s\S]{0,200}return new Response\('Invalid signature'/.test(webhook));
ok('webhook uses HMAC-SHA256', /name:\s*'HMAC'[\s\S]{0,60}SHA-256/.test(webhook));

// ── 6. Quota mutation runs through the service role ──────────────────────────

const tryon = read('supabase/functions/tryon/index.ts');
ok('tryon reserves via consume_try_on', /admin\.rpc\('consume_try_on'/.test(tryon));
ok('tryon refunds on failure', /refund_try_on/.test(tryon));
ok('tryon no longer updates profiles with the user client',
   !/await supabase\s*\n?\s*\.from\('profiles'\)\s*\n?\s*\.update/.test(tryon),
   'that path breaks once UPDATE is revoked, and silently — its error was never checked');

// ── 7. No secrets in shipped source ──────────────────────────────────────────

const clientFiles = ['popup.js', 'lib/supabase-client.js', 'background.js', 'content.js', 'manifest.json'];
for (const f of clientFiles) {
  const src = read(f);
  ok(`${f}: no Razorpay key`, !/rzp_(test|live)_[A-Za-z0-9]/.test(src));
  ok(`${f}: no Google API key`, !/AIza[0-9A-Za-z_\-]{20,}/.test(src));
  ok(`${f}: no service_role JWT`, !/service_role/.test(src));
}

for (const f of ['supabase/functions/billing/index.ts', 'supabase/functions/razorpay-webhook/index.ts']) {
  const src = read(f);
  ok(`${f}: Razorpay credentials come from env`, /Deno\.env\.get\('RAZORPAY_/.test(src));
  ok(`${f}: no hardcoded Razorpay key`, !/rzp_(test|live)_[A-Za-z0-9]/.test(src));
}

// ── 8. MV3 constraints the payment flow depends on ───────────────────────────

const manifest = JSON.parse(read('manifest.json'));
ok('manifest is MV3', manifest.manifest_version === 3);
ok('no remote script is referenced in the extension',
   !clientFiles.some(f => /https?:\/\/checkout\.razorpay\.com/.test(read(f))),
   'MV3 default CSP is script-src \'self\'; a remote checkout.js cannot load');

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL  ' + f);
  process.exitCode = 1;
}
