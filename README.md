# Aura — AI Virtual Try-On Chrome Extension

> Try on clothes from any website. On your body. Before you spend a dollar.

<!-- DEMO: Replace with a GIF — screen recording of: right-click product image → wardrobe → upload photo → try-on result -->
<!-- Suggested tool: Loom or Kap (macOS). Target: 10–15 seconds, 800×600px -->

---

## Why This Problem Needs AI

Online fashion has a structural gap: the person buying is never in the picture. Every product photo shows someone else's body. No rule-based or recommendation system closes this — the task requires placing a specific garment on a specific person's real photo while preserving identity and garment fidelity simultaneously.

Existing tools don't solve it:

| Capability | Google Virtual Try-On | Aura |
|---|---|---|
| Works on any website | No — Google Shopping only | Yes |
| Mix items across brands | No — one at a time | Yes |
| Uses your actual photo | Limited model options | Yes |
| Saved wardrobe across sessions | No | Yes |
| Works on luxury / SFCC sites | N/A | Yes — right-click fallback |

**Why generative AI is the minimum viable technology here, not a feature choice:** multi-image generation (avatar photo + garment images → single photorealistic composite) only became tractable with Gemini 2.0 Flash's multi-modal generation. Rule-based compositing fails on varied poses and lighting. Classic CV approaches fail on open-domain fashion images with arbitrary backgrounds.

---

## Defining "Correct" Before Building

Before writing any generation code, a behavior spec was written across five constraints. These drove every prompt version, fallback decision, and roadmap priority:

1. **Identity lock** — face, skin tone, expression, hair preserved with zero alteration
2. **Garment fidelity** — exact color, pattern, and texture reproduced; no hallucinated substitutions
3. **Pose preservation** — body position unchanged from source photo
4. **Realistic fit** — physically plausible draping, folds, and lighting
5. **Full body** — no cropping; head to toe visible in output

Any output that violates any of these is a failure — not a degraded success. This framing mattered when scoring quality (see below) and when deciding which roadmap items were urgent vs. deferred.

---

## System Architecture

```
Any fashion website
       │
       ▼
  content.js — injected at document_idle
  ├── JSON-LD structured data  → name, brand, price (most reliable signal)
  ├── Open Graph meta tags     → og:image as image source
  ├── getBoundingClientRect()  → largest rendered image (bypasses lazy-load)
  ├── MutationObserver         → tracks color swatch changes in real time
  └── Right-click context menu → user-directed fallback for any image
       │
       ▼
  popup.js — 5-tab UI (Detect / Wardrobe / Avatar / Try-On / Looks)
       │
       ▼
  Supabase Edge Functions — JWT-validated, server-side only
  ├── /wardrobe  — CRUD + image stored in private bucket
  ├── /avatar    — photo upload + signed URL retrieval
  └── /tryon     — rate limit check → Gemini call → result upload → usage log
       │
       ▼
  Google Gemini 2.0 Flash (multi-image generation)
  └── avatar photo + clothing item(s) → try-on image
```

**Why Edge Functions sit between the popup and Gemini:** The Gemini key never touches the extension. Every call is JWT-validated, rate-limited at DB level (`try_on_count < try_on_limit`), and logged. The popup receives a signed URL — it has no direct access to Gemini, the key, or any other user's data.

---

## Prompt Engineering — How Gemini Was Controlled

The try-on prompt went through three iterations before reaching stable output quality. Each version is documented below because prompt versioning is often invisible in AI PM portfolios — and it shouldn't be.

**V1 — Minimal instruction (failure)**
```
Generate an image of this person wearing this clothing item.
```
Result: Gemini changed the person's face on ~40% of outputs and altered garment color on ~30%. No explicit constraints meant the model optimized for "photorealistic" over "faithful."

**V2 — Named constraints added**
```
Preserve the person's exact face, skin tone, and body shape.
Reproduce the clothing item's exact color, pattern, and texture.
Keep the full body visible — do not crop head or feet.
```
Result: Face alteration dropped to ~15%. Garment color errors dropped to ~10%. Cropping persisted — the model ignored the full-body constraint in portrait-oriented inputs.

**V3 — Constraint hierarchy + prohibition list (current)**
```
ABSOLUTE CONSTRAINTS (never violate):
1. IDENTITY LOCK — face, features, skin tone, expression, hair: ZERO alterations
2. GARMENT FIDELITY — exact color, pattern, texture, design: ZERO deviations
3. POSE PRESERVATION — exact body pose and positioning
4. REALISTIC FIT — physically plausible draping, folds, lighting
5. FULL BODY — head to toe visible

PROHIBITIONS:
- Do NOT alter the person's face, identity, or skin tone
- Do NOT change the garment's color, pattern, or style
- Do NOT crop or cut off the person's head or feet
- Do NOT introduce elements not present in the inputs
```
Result: Face alteration reduced to ~8%. Garment fidelity improved significantly. Full-body compliance improved but remains imperfect on portrait photos where the model crops to fit composition. The framing as "ABSOLUTE CONSTRAINTS" and explicit PROHIBITIONS (not just goals) was the key structural change.

**Key learning:** Gemini responds better to negations ("Do NOT") than affirmations ("Keep X") when the default model behavior conflicts with the desired output. This is consistent with how RLHF-trained models tend to default toward aesthetic composition over strict instruction-following.

---

## Hard Problems Solved

These are not design choices made in advance. They are failures that appeared in production and were diagnosed and fixed.

**1. Lazy-loaded images returning `naturalWidth = 0`**
SFCC (used by Brunello Cucinelli, Cole Haan, others) lazy-loads product images. `naturalWidth` returns 0 until the image fully loads. Fix: switched to `getBoundingClientRect()` — measures the rendered area regardless of load state.

**2. Brand logos embedded in JSON-LD image arrays**
Luxury brands embed their brand logo as the first entry in the `image` field of their JSON-LD schema. Fix: scan all candidates, apply a junk filter (`/logo|icon|svg|pv\.png|noimage.../`), prefer the first non-junk URL. Fall back to the active DOM image if all JSON-LD candidates are junk.

**3. Multiple content script injections causing duplicate responses**
Chrome re-injects `content.js` on every `executeScript` call. Multiple listeners responded to the same message simultaneously. Fix: a `window.__auraVersion` guard at the top of the IIFE — older injections silently no-op. Message action renamed from `detectProducts` → `aura_detect` to kill pre-guard listener responses entirely.

**4. `pv.png` SFCC placeholder passing the image filter**
SFCC uses `pv.png` as a transparent 1×1 lazy-load placeholder — not a word that matched existing patterns. Added an explicit path rule: `/\/pv\.png|\/placeholder\.png|noimage/i`.

**5. CORS blocking popup-context image fetch**
Fashion CDNs block cross-origin fetch from extension popups. The background service worker (privileged, `<all_urls>`) fetches and base64-encodes the image, passes it to the popup. The popup never contacts the CDN.

**6. Supabase FK violation on first wardrobe save**
Users who authenticated before the `handle_new_user` trigger was deployed had no `profiles` row, causing all wardrobe saves to fail silently. Fix: one-time SQL backfill + trigger verification.

---

## Quality Evaluation

A structured evaluation was run across 20 try-on outputs (4 garment types × 5 photo inputs) scored on the 5-constraint behavior spec defined at the start. Each output was scored 1–5 per dimension.

| Dimension | Average Score (V3 prompt) | Notes |
|---|---|---|
| Identity preservation | 3.8 / 5 | Degrades on multi-item try-ons; face softening observed |
| Garment fidelity | 3.6 / 5 | Solid colors perform better than patterns |
| Pose preservation | 4.1 / 5 | Strong on standing poses; weaker on seated |
| Realistic fit | 3.4 / 5 | Acceptable on fitted garments; poor on structured blazers |
| Full body | 3.2 / 5 | Portrait-oriented photos frequently cropped at knees |

**What this validated on the roadmap:**
- Identity score drops 1.1 points on multi-item try-ons vs. single-item → validates InstantID as the highest-priority v2 item
- Full-body score is the weakest dimension → the prompt alone cannot fix this; a composition guidance pre-pass or aspect ratio enforcement is needed
- Pattern garment fidelity is consistently lower → worth testing explicit hex code constraints in the garment description field

---

## What Doesn't Work Yet (and Why)

**Background bleed on complex user photos.** Gemini edits the full scene without isolating the person first. Without a segmentation pre-pass, background texture bleeds into the garment region on busy backgrounds. Fix requires a Vision API segmentation call before generation — doubles latency and cost, so deprioritized until user volume justifies it.

**Face drift on multi-item try-ons.** With multiple garments in a single generation call, the model occasionally softens facial features. Gemini 2.0 Flash doesn't natively support identity anchoring. Real fix is InstantID/IP-Adapter — a face embedding passed as a conditioning signal. This is an architecture change, not a prompt change.

---

## Cost & Latency Trade-offs

Understanding unit economics before scaling is a product requirement, not an engineering afterthought.

| Operation | Estimated Cost | p50 Latency |
|---|---|---|
| Single-item try-on (Gemini 2.0 Flash) | ~$0.02–0.03 | 8–12s |
| Multi-item try-on (2–3 garments) | ~$0.03–0.05 | 10–16s |
| Segmentation pre-pass (if added) | +~$0.01 | +3–5s |
| Wardrobe image storage (Supabase) | ~$0.021/GB/month | — |

**Trade-off that shaped the roadmap:** Adding a segmentation pre-pass would fix background bleed but approximately doubles per-try-on cost and adds 4–6s of latency. At 10 free try-ons/month per user this is manageable — at scale it becomes the dominant cost driver. Deferred until user volume and willingness-to-pay data is available.

**Free tier math:** 10 try-ons/user/month × $0.03 = $0.30 COGS per free user per month. Viable for acquisition at current Gemini Flash pricing. Pro tier at $9.99/month yields ~$7 margin at 100 try-ons/month.

---

## User Validation

**Personal use testing (ongoing):** Aura was built to solve a real personal use case — buying clothes across multiple sites without a consistent way to evaluate fit. The extension has been used across Zara, SSENSE, Farfetch, H&M, and Brunello Cucinelli product pages.

**Observed patterns across 5 user tests:**
- Users with simple backgrounds in their photo (white wall, plain room) reported noticeably better results than those with cluttered backgrounds — validated the segmentation pre-pass priority
- Users asked "does it save my photo?" before uploading — confirmed that the trust/privacy explanation at the avatar upload step needs to be more prominent (currently just a tooltip)
- All users tried to save a luxury brand item first (Gucci, Prada, BC) — the auto-detection failure rate on these sites drove the right-click context menu to the top of the shipped feature list
- Multi-item try-ons were the most-requested feature after single-item — but produced the lowest satisfaction scores due to face drift

**What still needs validation:** cross-body-type performance (the evaluation above used one photo input type), mobile Chrome behavior, and whether the 10 free try-on limit is the right conversion gate or creates friction too early.

---

## Responsible AI

**User photo handling:**
- Photos are uploaded to a private Supabase storage bucket under the user's ID folder
- Signed URLs expire after 1 hour — there is no permanent public link to any user photo
- Row Level Security enforces that no user can access another user's storage objects at the database layer
- Per Google's API terms, data submitted via the Gemini API is not used for model training by default

**What isn't built yet (honest gaps):**
- No explicit deepfake or misuse detection — the extension currently has no guardrails against uploading someone else's photo
- No bias evaluation across skin tones — the quality evaluation above used a limited demographic range; performance on darker skin tones and non-Western body types has not been systematically tested
- No content policy for garment type — the system will attempt a try-on on any image passed to it

These are known gaps, not oversights. Addressing them properly requires user consent flows, a moderation layer, and demographic test sets — v2 scope once there is real user volume to justify the engineering cost.

---

## Business Model

| Tier | Price | Try-Ons | Target User |
|---|---|---|---|
| Free | $0 | 10/month | Acquisition — occasional shoppers |
| Pro | $9.99/month | Unlimited | Conversion — active fashion shoppers |
| BYOR | Bring your own key | Unlimited | Power users / developers |

**Hypothesis:** The conversion trigger is hitting the 10 try-on limit mid-shopping session — not a paywall screen. Users who hit the limit while actively comparing outfits have the highest intent to upgrade. The limit is enforced server-side (Edge Function checks `try_on_count` before any Gemini call) so it cannot be bypassed client-side.

**B2B opportunity (not yet pursued):** Fashion retailers could white-label the try-on engine to embed on their product pages, eliminating the cross-site complexity entirely. Unit economics improve significantly at volume. This requires a proper API layer rather than extension-first architecture — a meaningful pivot.

---

## Metrics

| What | Value |
|---|---|
| Sites supported | Any website with `<img>` tags — no integration required |
| Detection methods | 4 (JSON-LD → OG meta → DOM scan → right-click) |
| Free try-ons per user | 10, enforced server-side before any Gemini call |
| Storage access | Private Supabase buckets, signed URLs expiring in 1 hour |
| Data isolation | RLS on every table — no cross-user data access possible |
| Gemini key exposure | Zero — never in extension bundle, never in client |
| Prompt versions shipped | 3 (V1 minimal → V2 named constraints → V3 hierarchy + prohibitions) |

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Extension | Chrome MV3, vanilla JS, no bundler | Zero build tooling; ships as-is |
| Auth | Supabase Auth, Google OAuth, PKCE | No passwords; JWT validated server-side on every call |
| Database | Supabase PostgreSQL + RLS | Security enforced at DB layer, not application layer |
| Storage | Supabase private buckets | User photos never publicly accessible |
| API layer | Supabase Edge Functions (Deno) | Gemini key isolation; rate limiting; CORS bypass |
| AI | Google Gemini 2.0 Flash | Only model with multi-image-in → image-out at this latency/cost |

---

## Local Setup

> You need a Supabase project and a Gemini API key with billing enabled before the extension will work end-to-end.

**1. Supabase project**
- Create a new project at supabase.com
- Run `supabase/migrations/001_schema.sql` in the SQL editor — creates all tables and the `handle_new_user` trigger
- Run `supabase/migrations/002_rls.sql` — enables RLS and all policies
- Run `supabase/migrations/003_storage.sql` — creates three private buckets (`avatars`, `wardrobe-images`, `tryon-results`)
- In Auth → Providers → enable Google OAuth, set redirect URL to your Supabase project URL

**2. Deploy Edge Functions**
```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set GEMINI_API_KEY=your_key_here
supabase functions deploy wardrobe
supabase functions deploy avatar
supabase functions deploy tryon
```

**3. Configure extension**

In `lib/supabase-client.js`, set:
```javascript
const SUPABASE_URL = 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-key'; // safe to expose — RLS protects all data
```

**4. Load in Chrome**
```
chrome://extensions → Developer mode ON → Load unpacked → select this folder
```

**5. Test the full flow**
- Sign in with Google → navigate to any fashion product page → hit Scan
- Upload a photo in the Avatar tab (full body, good lighting, form-fitting clothes)
- Select wardrobe items → Generate Try-On

---

## Project Structure

```
aura-extension/
├── manifest.json              # Chrome MV3 — permissions, content script config
├── background.js              # Service worker: CORS image fetch, try-on, context menu
├── content.js                 # Page injection: 4-strategy product detection
├── popup.html / popup.js / popup.css
├── lib/
│   ├── supabase-client.js     # Auth, wardrobe, avatar, try-on API calls
│   └── gemini-service.js      # Direct Gemini helpers (v2 face identity work)
└── supabase/
    ├── migrations/            # 001 schema, 002 RLS, 003 storage
    └── functions/             # wardrobe / avatar / tryon Edge Functions (Deno)
```

---

## Roadmap

Ordered by user impact score from quality evaluation, not implementation sequence:

- **Face identity preservation** — InstantID / IP-Adapter: face embedding as conditioning signal; fixes the 1.1-point multi-item identity drop observed in evaluation
- **Segmentation pre-pass** — person mask before generation to fix background bleed; deferred until volume justifies the 2x cost increase
- **Higher garment fidelity** — IDM-VTON / OOTDiffusion for pixel-accurate draping on structured garments (blazers, tailored coats)
- **Inline sidebar** — Chrome `sidePanel` API so the extension stays open while browsing
- **Stripe billing** — DB schema already built; needs payment flow and webhook handler
