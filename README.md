# Aura — AI Virtual Try-On

Save clothes from any fashion website. Try them on your own photo. Powered by Google Gemini.

<!-- Demo GIF: scan page → save item → generate try-on -->

---

## What It Does

Browse any fashion site, hit **Scan**, and Aura detects the product on the page. Save it to your wardrobe. Upload one photo of yourself. Select items and generate a photorealistic try-on — all inside a Chrome extension popup.

- Detects clothing on any product page — name, price, category, image
- Right-click any image to save it manually (for sites where auto-detection misses)
- Wardrobe persists across sessions, filterable by category
- Mix items from different sites in one try-on
- Saved looks gallery

---

## Install

> **Beta:** Load the extension manually until the Chrome Web Store listing is live.

1. Download or clone this repo
2. Open Chrome → `chrome://extensions` → turn on **Developer mode**
3. Click **Load unpacked** → select the `drip-extension` folder
4. Sign in with Google when the popup opens

That's it. No API key needed — try-on runs on the backend.

---

## How to Use

**1. Scan a product page**
Navigate to any clothing item page and click **Scan**. Works best on dedicated product pages (not category pages or homepages). On JS-heavy sites like Myntra or Zara, wait for the page to fully load before scanning.

**2. Save to your wardrobe**
Click **Save to Wardrobe** on any detected item. The image and details save to your account.

**3. Set up your avatar**
Go to the **Avatar** tab. Upload a photo of yourself — full body, facing forward, good lighting. This is the base for every try-on.

**4. Generate a try-on**
Go to **Try-On**. Drag items from your wardrobe into the outfit zone, or select them from the strip at the bottom. Hit **Generate Try-On**. Takes 15–30 seconds.

**5. Save your looks**
Hit **Save This Look** on any result. View saved looks in the **Looks** tab.

---

## Known Limitations

- **Avatar likeness:** The avatar is AI-generated from your photo. It preserves your body shape and skin tone but is not a pixel-perfect mirror. Face identity improves in v2 (InstantID).
- **SPA sites:** Myntra, Zara, and ASOS load product data via JavaScript after the page renders. If Scan returns nothing, wait a few seconds for the page to finish loading and try again.
- **Garment accuracy:** Gemini reproduces colors and patterns well on simple items. Complex prints, logos, or structured tailoring (blazers, suits) may not reproduce perfectly.
- **Free tier:** 25 try-ons on the free plan.

---

## Roadmap

- Face identity preservation (InstantID)
- Better structured garment accuracy (IDM-VTON)
- Sidebar panel — stays open while you browse
- Chrome Web Store listing
- Shareable look cards

---

## Self-Hosting

If you want to run your own backend:

1. Create a [Supabase](https://supabase.com) project
2. Run the migrations in order: `supabase/migrations/001_schema.sql` → `002_rls.sql` → `003_storage.sql` → `004_beta_limits.sql`
3. Enable Google Auth: Supabase Dashboard → Authentication → Providers → Google
4. Deploy the edge functions:
   ```bash
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase secrets set GEMINI_API_KEY=your_key
   supabase functions deploy wardrobe avatar tryon
   ```
5. Replace `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `lib/supabase-client.js` with your project values
