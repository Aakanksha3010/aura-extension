# Aura — AI Virtual Try-On

Save clothes from any website. Try them on your real photo. Powered by Google Gemini.

<!-- Add a demo GIF here — screen record: scan page → save item → upload photo → generate try-on -->

---

## What It Does

- **Scan any fashion website** — Aura detects clothing items automatically (Zara, SSENSE, Farfetch, ASOS, and more)
- **Right-click to save** — on luxury sites where auto-detection fails, right-click any image → Save to Aura Wardrobe
- **Build a wardrobe** — items save across sessions, searchable by name, brand, or category
- **Try on outfits** — upload one photo of yourself, select items, generate a photorealistic try-on
- **Mix brands** — combine pieces from five different sites in one try-on

---

## Prerequisites

You need three things before setup:

1. **Google Chrome**
2. **A Supabase account** — free tier works — [supabase.com](https://supabase.com)
3. **A Gemini API key** with billing enabled — [aistudio.google.com](https://aistudio.google.com)

---

## Setup

### Step 1 — Create your Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Once it's ready, open the **SQL Editor** and run these three files in order:
   - `supabase/migrations/001_schema.sql`
   - `supabase/migrations/002_rls.sql`
   - `supabase/migrations/003_storage.sql`
3. Go to **Authentication → Providers → Google** and enable Google sign-in
4. Copy your **Project URL** and **Anon Key** from **Settings → API**

### Step 2 — Add your credentials to the extension

Open `lib/supabase-client.js` and replace these two lines:

```js
const SUPABASE_URL = 'YOUR_PROJECT_URL';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```

### Step 3 — Deploy the backend functions

Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then run:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set GEMINI_API_KEY=your_gemini_key_here
supabase functions deploy wardrobe
supabase functions deploy avatar
supabase functions deploy tryon
```

Your project ref is in your Supabase dashboard URL: `supabase.com/dashboard/project/YOUR_PROJECT_REF`

### Step 4 — Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top right toggle)
3. Click **Load unpacked** and select this folder
4. The Aura icon will appear in your toolbar

### Step 5 — Sign in and start

1. Click the Aura icon
2. Sign in with Google
3. Go to any fashion product page and hit **Scan**
4. Upload your photo in the **Avatar** tab
5. Pick items from your wardrobe → **Generate Try-On**

---

## How It Works

```
Fashion website
    ↓
content.js detects products (JSON-LD → Open Graph → DOM scan → right-click)
    ↓
popup.js saves items to Supabase via Edge Functions
    ↓
Supabase /tryon function calls Gemini with your photo + garment images
    ↓
Try-on result returned and saved
```

The Gemini API key lives only in Supabase — it is never in the extension.

---

## Project Structure

```
aura-extension/
├── manifest.json          # Chrome extension config
├── background.js          # Handles image fetching and right-click menu
├── content.js             # Detects products on any webpage
├── popup.html/js/css      # The extension UI
├── lib/
│   └── supabase-client.js # All API calls (auth, wardrobe, avatar, try-on)
└── supabase/
    ├── migrations/        # Run these once to set up your database
    └── functions/         # wardrobe / avatar / tryon — deployed to Supabase
```

---

## Troubleshooting

**Extension shows a blank page after sign-in**
→ Check that all three SQL migration files ran without errors in Supabase

**"Failed to save item" error**
→ Make sure your Supabase project has the `handle_new_user` trigger from `001_schema.sql`

**Try-on fails immediately**
→ Confirm your Gemini API key is set: `supabase secrets list` should show `GEMINI_API_KEY`

**Site not detected (luxury brands like Brunello Cucinelli)**
→ Use right-click → **Save to Aura Wardrobe** on the product image directly

---

## Roadmap

- Face identity preservation across try-ons (InstantID)
- Better garment accuracy on structured items like blazers (IDM-VTON)
- Sidebar panel so the extension stays open while you browse
- Chrome Web Store listing
