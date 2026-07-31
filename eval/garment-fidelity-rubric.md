# Garment Fidelity Eval

A lightweight, reproducible way to measure how faithfully the try-on reproduces a
selected garment. Produces a single **garment-fidelity %** you can cite, with a
defined method and sample size behind it.

## Definition

For each try-on result, score the rendered garment against its **original product
image** on 4 attributes (1 = preserved, 0 = not):

| Attribute   | Preserved (1) if…                                              |
|-------------|----------------------------------------------------------------|
| **Color**   | The dominant color / shade matches the product.                |
| **Pattern** | Prints, stripes, logos, textures are reproduced (N/A = solid → score 1). |
| **Silhouette** | The garment type/shape is kept (a blazer stays a blazer).   |
| **Details** | Key details survive (collar, neckline, sleeves, buttons, fastenings). |

**Item fidelity = attributes preserved ÷ 4.**
**Overall garment fidelity % = mean of item fidelities × 100.**

## Method (how to run it)

1. Pick **15–20 garments** spanning difficulty: flat/simple tops, patterned items,
   dresses, blazers, and hard cases (draped/asymmetric). Record the mix — fidelity
   is higher for flat garments and lower for draped ones, so the sample matters.
2. Use **one clean avatar** (plain background, simple fitted clothing) to isolate
   garment fidelity from avatar-quality effects.
3. Generate a try-on for each garment. Save the result image next to the product image.
4. Score each item in `fidelity-scores.csv` (0/1 per attribute).
5. Compute the mean. That's your citable number.

## Reporting honestly

- State the method + N: *"~85% garment fidelity, measured across N=20 items on a
  4-attribute rubric (color, pattern, silhouette, details)."*
- Break it out by difficulty if you can: *"higher on flat garments, lower on
  draped/asymmetric pieces — a known image-model limitation."*
- Keep 3–4 example screenshots (a good case + a failure) for your portfolio.

## Optional automated support (verify library APIs before relying on them)

These measure *similarity*, not true fidelity — use only to support human scores:
- **Color**: CIELAB ΔE between product and rendered-garment crop.
- **Semantic**: CLIP / image-embedding cosine similarity.
- **Structural/perceptual**: SSIM or LPIPS.

## Improving the number

- Feed **flat, front-on, background-removed** garment crops as the reference.
- **Generate-N-and-pick-best**: generate 3–4 candidates, auto-score, return the top.
- Keep prompt language explicit about exact color/pattern reproduction.
- Scope claims to garment types that reproduce well.
