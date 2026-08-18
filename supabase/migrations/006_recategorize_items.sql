-- Repair categories on wardrobe items saved before the 2026-07-31 fix that
-- replaced the bare `short` rule with `\bshorts\b`.
--
-- The old rule matched any name CONTAINING "short", and the `bottom` branch is
-- evaluated before `outerwear`/`dress`/`shoes`, so names like "Short Blazer",
-- "Short Trench Coat" or "Short Boots" were stored as `bottom`. The try-on
-- prompt maps `bottom` -> "lower body only (waist to feet)", i.e. a blazer gets
-- rendered on the legs.
--
-- Deliberately conservative:
--   * only names that UNAMBIGUOUSLY name the garment type are touched;
--   * ambiguous compounds ("shirt dress", "jacket dress", "boot cut jeans",
--     "dress shorts", "dress shirt") are excluded rather than guessed;
--   * every statement is a no-op for rows already in the right category, so
--     the migration is idempotent and safe to re-run.
--
-- `\y` is the Postgres POSIX word boundary, so "coat" does not match "coated"
-- and "boot" does not match "bootcut".

-- ── outerwear ────────────────────────────────────────────────────────────────
update public.wardrobe_items
set category = 'outerwear'
where category is distinct from 'outerwear'
  and name ~* '\y(blazers?|jackets?|coats?|overcoats?|trench ?coats?|raincoats?|peacoats?|parkas?|windbreakers?|anoraks?)\y'
  -- skip garments where the outerwear word is only a modifier
  -- also skip "shirt jacket"/"shacket"-style hybrids, which could be either
  and name !~* '\y(dress|dresses|gown|gowns|jumpsuits?|rompers?|shirts?|blouses?|tees?|t-shirts?|tanks?|shoes?|boots?|sneakers?|sandals?|bags?|totes?|backpacks?|handbags?|clutch|wallets?|purses?)\y';

-- ── dress ────────────────────────────────────────────────────────────────────
update public.wardrobe_items
set category = 'dress'
where category is distinct from 'dress'
  and name ~* '\y(dress|dresses|sundress|sundresses|maxi ?dress|midi ?dress|mini ?dress|gowns?|jumpsuits?|rompers?)\y'
  -- "dress shirt", "dress pants", "shirt dress", "dressing gown", "dress shorts"
  -- are all excluded: the word "dress" there is a modifier, not the garment.
  and name !~* '\y(dressing ?gowns?|shirts?|blouses?|tees?|tanks?|sweaters?|hoodies?|pants?|trousers?|jeans?|denim|skirts?|shorts|leggings?|chinos?|shoes?|boots?|sneakers?|sandals?|heels?|socks?|blazers?|jackets?|coats?|bags?|totes?|clutch|belts?)\y';

-- ── shoes ────────────────────────────────────────────────────────────────────
update public.wardrobe_items
set category = 'shoes'
where category is distinct from 'shoes'
  and name ~* '\y(shoes?|sneakers?|boots?|sandals?|loafers?|heels?|stilettos?|espadrilles?)\y'
  -- "boot cut jeans", "boot cut trousers", "dress shoes"-adjacent bottoms, bags
  and name !~* '\y(cut|jeans?|denim|pants?|trousers?|leggings?|chinos?|skirts?|shorts|dress|dresses|gowns?|shirts?|blouses?|jackets?|blazers?|coats?|bags?|totes?|backpacks?|socks?)\y';

-- ── stragglers ───────────────────────────────────────────────────────────────
-- Rows with a NULL category (pre-edge-function direct inserts) break the try-on
-- request: the tryon function's Zod enum rejects null and 400s the whole
-- outfit. 'accessory' is the same fallback content.js/background.js use when no
-- keyword matches. Anything above that could be classified already has been.
update public.wardrobe_items
set category = 'accessory'
where category is null;
