# Aura — AI Virtual Try-On Chrome Extension

> Save clothes from any website. Try them on your real photo. Decide before you buy.

---

## The Problem

**User:** Someone shopping online across Zara, SSENSE, Brunello Cucinelli, and ASOS at the same time.

**Problem:** They can't see how any of it looks on *them*. Product photos show professional models in controlled lighting. The person browsing has no way to visualize whether a $400 pair of trousers and a shirt from a different brand actually work together — or on their own body. Existing tools like Google Virtual Try-On only work inside Google Shopping, on a single item at a time, with no wardrobe or cross-site capability.

**Action:** They install Aura. On any product page, they hit **Scan** — Aura detects the item, extracts the name, brand, price, and product image automatically. On luxury or hard-to-detect sites, they right-click any image and choose **Save to Aura Wardrobe** directly. Items accumulate in a personal wardrobe, searchable and filterable by category. When ready, they upload one real photo of themselves, select any combination of saved items, and hit **Generate Try-On**. Aura sends the photo + garment images to Gemini's image generation API and returns a photorealistic result of them wearing the outfit.

**Outcome:** They see exactly how the outfit looks on their body — not a model's — before spending anything. They can mix pieces from five different brands in one try-on. The wardrobe persists across sessions via Supabase, so their saved items are always there when they come back.

---

## How It Works

```
Any fashion website
       │
       ▼
  content.js (injected into page)
  ├── Reads JSON-LD structured data (most reliable: name, brand, price)
  ├── Reads Open Graph meta tags (og:image, og:title)
  ├── Finds the largest rendered image via getBoundingClientRect()
  ├── MutationObserver tracks color swatch changes in real time
  └── Right-click context menu as fallback for any image on any page
       │
       ▼
  popup.js (extension popup)
  ├── Renders detected products with Save button
  ├── Wardrobe tab: searchable, filterable grid (synced to Supabase)
  ├── Avatar tab: upload your photo + photo guidance tips
  ├── Try-On tab: drag-and-drop outfit builder
  └── Looks tab: saved try-on history
       │
       ▼
  Supabase Edge Functions (server-side API)
  ├── /wardrobe  — CRUD for wardrobe items (images stored in private bucket)
  ├── /avatar    — Save/fetch user photo (private storage, signed URLs)
  └── /tryon     — Calls Gemini with server API key, enforces rate limit,
                   uploads result image, logs usage
       │
       ▼
  Google Gemini API (gemini-2.0-flash-exp and family)
  └── Multi-image generation: avatar photo + clothing item(s) → try-on result
```

---

## Key Design Decisions

| Decision | Why |
|----------|-----|
| Real photo, not generated avatar | Generated avatars are generic and don't look like the user. Try-on quality is directly tied to photo realism. Using the actual photo gives far better results. |
| Server-side Gemini key | Keeps the API key out of the extension entirely. Users authenticate with Google OAuth; the Edge Function validates their JWT before calling Gemini. |
| Right-click context menu | Auto-detection fails on luxury brands (Brunello Cucinelli, etc.) that use SFCC lazy-load placeholders and embed brand logos in their JSON-LD. Right-click lets the user point directly at the image they can see. |
| `getBoundingClientRect()` over `naturalWidth` | Lazy-loaded images have `naturalWidth = 0` until fully loaded. Rendered area from `getBoundingClientRect()` works reliably even for images that haven't finished loading their natural dimensions. |
| Supabase private storage + signed URLs | Product images and user photos are never publicly accessible. All URLs expire after 1 hour and are re-signed on each load. |
| Version guard in content script | Chrome injects content scripts on every `executeScript` call. Multiple injections create multiple `onMessage` listeners that all respond, causing race conditions. A `window.__auraVersion` guard silences all but the current version. |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension | Chrome MV3, vanilla JS, no bundler |
| Auth | Supabase Auth (Google OAuth, PKCE flow) |
| Database | Supabase PostgreSQL with Row Level Security |
| Storage | Supabase private buckets (avatars, wardrobe-images, tryon-results) |
| API layer | Supabase Edge Functions (Deno) |
| AI | Google Gemini 2.0 Flash (image generation + editing) |
| Hosting | Supabase cloud (Mumbai region) |

---

## Features

- **Scan any page** — detects clothing items from JSON-LD, Open Graph, and DOM on any fashion website
- **Right-click to save** — works on any image, anywhere, bypassing detection entirely
- **Cross-site wardrobe** — save from Zara, SSENSE, Farfetch, Brunello Cucinelli, ASOS — all in one place
- **Wardrobe search** — filter by category (tops, bottoms, dresses, shoes, outerwear, accessories) or search by name and brand
- **Real-photo avatar** — upload one photo of yourself; Aura uses it directly for try-on
- **Photo guidance** — built-in tips for getting a photo that produces the best try-on results (full body, good lighting, form-fitting)
- **Multi-item try-on** — select multiple garments, drag-and-drop outfit builder, conflict detection (dress + pants warning)
- **Outfit conflict detection** — warns before generating a try-on that makes no physical sense
- **Looks history** — every try-on result is saved locally so you can revisit

---

## Local Setup

1. Clone this repo
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select the repo folder
5. Open Settings (⚙️) → enter your Gemini API key (requires billing enabled)
6. Sign in with Google

---

## Project Structure

```
aura-extension/
├── manifest.json          # Chrome MV3 manifest
├── background.js          # Service worker: image fetch, try-on, context menu
├── content.js             # Page injection: product detection + image observation
├── popup.html             # Extension popup markup
├── popup.js               # Popup logic: all tabs, state, API calls
├── popup.css              # Styles
├── lib/
│   ├── supabase-client.js # Auth, wardrobe, avatar, try-on API helpers
│   └── gemini-service.js  # Legacy Gemini helpers (kept for v2 avatar work)
├── supabase/
│   ├── migrations/        # SQL schema + RLS policies
│   └── functions/         # Edge Functions: wardrobe, avatar, tryon
└── icons/
```

---

## What's Next (v2)

- **Sidebar panel** (Chrome `sidePanel` API) — persistent panel instead of popup, so it stays open while browsing
- **Garment fidelity** (IDM-VTON / OOTDiffusion) — pixel-accurate draping instead of Gemini re-generation
- **Face identity** (InstantID / IP-Adapter) — preserve face across multi-angle views
- **Manual category override** — edit detected category on saved items
- **Stripe billing** — pro tier for unlimited try-ons (schema already built)
