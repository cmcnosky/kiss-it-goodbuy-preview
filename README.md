# Kiss It Good Buy — owner-review storefront

Public review site: [https://cmcnosky.github.io/kiss-it-goodbuy-preview/](https://cmcnosky.github.io/kiss-it-goodbuy-preview/)

This repository contains an independently hosted storefront proposal for Kiss It Good Buy. It uses the merchant's existing public Shopify catalog and hands checkout, payment, customer accounts, gift-card delivery, pickup, policies, and order processing back to Shopify. It has not replaced the official domain or Shopify theme, and publication on the official domain requires the business owner's approval and store access.

## Recorded catalog scope

The release catalog was fetched from the merchant's public Shopify endpoints on November 6, 2026 at 12:05 p.m. Central (`2026-11-06T18:05:54.291Z`):

- 249 published products
- 253 variants
- 31 collections
- Five gift-card denominations

The merchant's `JUST ADDED` collection contained the complete 249-product catalog at that snapshot. The review site therefore presents that route as newest-first inventory; it does not claim that all 249 pieces were added recently.

Catalog counts and availability are time-specific. The browser checks the public store when a shopper visits, the deployment workflow can refresh the catalog on its daily run, and Shopify remains authoritative at checkout.

## What the owner is reviewing

The proposal is intended to make a one-owner retail operation easier to understand and shop without creating a second inventory system:

- A gallery-led homepage: an actual showroom photograph, inventory search and directory, a browsable arrivals shelf, and three differently arranged displays for lighting, furniture, and art. Product selections come from available photographed inventory with category-specific fallbacks; archive photographs are labeled separately. The original lipstick-kiss artwork is preserved in the readable curved wordmark.
- Full-catalog search, Shopify relevance and best-selling order, collection/type/brand/availability/price filters, pagination, and bookmarkable filter state.
- New-arrival presentation based on merchant publication timestamps, while preserving the store's existing collection memberships.
- Product galleries, variants, exact integer-cent prices, compare-at prices, item references, source descriptions, listed measurements, live pickup information where Shopify exposes it, related items, and recently viewed pieces.
- Explicit no-photo treatments. Brand artwork is not described as a product photograph.
- A browser-local shortlist with side-by-side comparison and a shareable inquiry containing item numbers and live listing links. The inquiry gives shoppers space to add room measurements and a room photograph; it does not promise a formal design service.
- A browser-local shopping bag that preserves exact Shopify variant IDs, quantities, and integer-cent totals. The proposal bag is disclosed as separate from a cart started on the original store, and the original cart remains directly accessible.
- Checkout validation against current Shopify availability, price, currency, and quantity rules. Changed or previously unknown prices require review before cart creation; missing items, warnings, and line or quantity mismatches block redirect.
- Native gift-card recipient personalization, customer-account, consignor-account, policy, social, contact, directions, and original-product routes.
- A structured consignment-email helper with a photo checklist and published terms. It prepares text for the owner's existing inbox; it does not upload files or send a submission by itself.

Saving a product does not hold or reserve it. Stock, price, taxes, pickup details, and payment are finalized by the merchant's Shopify checkout.

## Owner Studio — an actual local practice workspace

Open the permanent public review address, then **Open Owner Studio**. No login or subscription is needed. Everyone starts from the original storefront; a visitor's draft is local to that browser and never becomes another visitor's storefront.

- Design controls change six palette colors, heading/body type, text scale, border weight, spacing, three homepage compositions, product columns, and image treatment. The protected Studio controls remain readable while the storefront palette changes.
- Words & contact edits the homepage welcome and displayed contact details. This is a focused editor, not a free-form page builder or an editor for every paragraph.
- Inventory includes every listing in the release snapshot. Practice overrides can change titles, prices, measurements, availability, visibility, and photographs. Gift-card denomination prices stay intact. Sample products can be added with real images; larger supported phone photos are resized locally, leaving the original file unchanged.
- Preview applies the saved draft to the actual storefront pages, search, product details, shortlist, planner, and a separate practice bag. Practice mode freezes the base catalog at the release snapshot so live refreshes do not overwrite experiments.
- Practice checkout records a local sample order with status management. Newsletter and consignment practice actions create local activity records. No Shopify cart, payment, reservation, outgoing email, subscription, or actual order is created in practice mode.
- Draft changes save in localStorage after successful validated changes. The UI reports failed/blocked storage and does not navigate into preview when the mode cannot be persisted.
- Recovery includes 25 undo steps, redo, up to 10 named versions, reset to original, and validated JSON backup export/import. Backups can transfer a draft to another browser/device; there is no automatic cloud sync or account authentication.
- Return to original exits practice mode and restores the original browsing/cart namespace while retaining the draft. Named versions store designs/inventory; a full backup also includes local practice orders and activity.

Storage is finite, browser-specific, and can be removed by clearing site data or private-browsing cleanup. Export a backup before clearing data or changing devices. Limits include a 4 MB state envelope, 100 custom pieces, 250 listing overrides, 50 practice orders, and 25 practice activity records. A saved version containing uploaded photographs contributes to that storage limit. The UI surfaces validation errors instead of silently pretending a save succeeded. Anyone using the same browser profile can access that profile's Studio; use sample data rather than private customer records.

## Fit, pickup, and interrupted checkout

The fit & pickup planner compares saved pieces against a room, doorway, and vehicle opening, in inches or centimeters. It only makes dimensional comparisons when three axes and units are explicit or entered as shopper-confirmed measurements; unlabeled title dimensions remain unverified. Notes and measurements stay in the current tab/session and can be copied or printed. The worksheet is a planning aid, not a guarantee that furniture can be maneuvered through a route.

Safe Storefront reads can retry once after transient failures; cart creation is never automatically retried. A valid prepared Shopify checkout URL is retained for up to 15 minutes in that tab, tied to the exact bag fingerprint, so a blocked/interrupted redirect can be recovered without creating another cart. Changes to the bag, expiry, or an untrusted URL invalidate that recovery link.

## Catalog and release safety

The project uses no owner API secret and no second product database. Runtime reads use the public Shopify catalog and tokenless Storefront API. The explicit Storefront API version should be reviewed before Shopify retires it.

The permanent sharing address has no revision query suffix. Internal JavaScript and stylesheet URLs include content hashes so updated pages request matching assets instead of reusing older browser-cached files.

The GitHub Pages workflow runs on pushes to `main`, manual dispatch, and a daily schedule. It:

1. Stages only the public allowlist into `.build`.
2. Refreshes the catalog on every deployment against the currently published catalog, validating structure, timestamps, and abnormal count reductions before replacing staged files. A reviewed large reduction can use the explicit manual override; invalid structure and stale timestamps cannot.
3. Regenerates eleven entry pages and all product pages.
4. Runs syntax and focused catalog, commerce, recovery, planner, Studio state, merchandising, interaction, and cross-tab tests, plus Chromium browser journeys at desktop and mobile widths.
5. Uploads and deploys only after the build checks succeed.
6. Checks the deployed routes, matching share metadata, 1200×630 image, expected inventory hash/freshness, and a read-only Shopify dependency. A postdeploy failure reports a failed workflow; it does not automatically roll back or notify a staffed support service.

A failed refresh or test prevents a partial artifact from replacing the previously deployed Pages release. The workflow does not commit refreshed inventory back to the repository.

## Local verification

The focused scripts require Node.js 24; the separate browser suite uses its pinned Playwright dependency:

```bash
node scripts/sync-catalog.mjs --self-test
node scripts/test-commerce.mjs
node scripts/test-storefront-data.mjs
node scripts/test-storefront.mjs
node scripts/test-interactions.mjs
node scripts/test-cross-tab.mjs
node scripts/test-palette.mjs
node scripts/test-planner.mjs
node scripts/test-checkout-recovery.mjs
node scripts/test-studio-state.mjs
node scripts/test-studio-runtime.mjs
node scripts/test-release-guards.mjs
node scripts/test-catalog.mjs
node scripts/render-pages.mjs
```

`test-catalog.mjs` reconciles the canonical build with the dated raw and collection-membership evidence in `research/`. It is intentionally not run by the public deployment repository, whose staged build does not contain that non-deployed working evidence. The other listed release suites are dependency-free and self-contained against the staged public files.

## Repository layout

- `dist/` — deployable storefront, inventory, assets, and generated product pages
- `scripts/` — sync, render, staging, and test tools
- `deployment/github-pages.yml` — canonical GitHub Pages workflow template
- `research/` — dated source evidence and design provenance; excluded from the public Pages artifact
- `shopify/` — earlier optional theme-section integration starters; not the runtime behind this independent review site
- `licenses/` — bundled font licenses

## Boundaries before official adoption

Automated checks do not replace owner acceptance. Customer-account sign-in, newsletter confirmation, recipient gift delivery, assistive-technology testing, physical-device testing, live payment, post-purchase order handling, and the owner's operational fit still require authorized production validation. No test suite submits a purchase, payment, subscription, consignment request, or customer credentials.

The proposal should not be represented as proven to increase sales, conversion, or owner time savings. Those are measurable goals for an owner-authorized release, not results established by this review build.
