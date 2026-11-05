KISS IT GOOD BUY — COMPLETE STOREFRONT PROPOSAL

Website: https://cmcnosky.github.io/kiss-it-goodbuy-preview/

The complete live Shopify inventory, full product pages, search and filters, variants, a persistent browser bag, and real Shopify checkout. Plus shareable comparison and structured consignment inquiries.

The existing store remains authoritative for products, stock, prices, accounts, orders, payment, pickup, policies, subscriptions, and personalized gift-card delivery. This independently hosted proposal has not replaced the official domain. Its browser bag is separate from any bag started directly on the original store.

Local run: python3 -m http.server 8765

Rehearse publication:
  node _build-tools/stage-public-build.mjs
  node .build/scripts/render-pages.mjs --dist .build/dist
  node .build/scripts/test-commerce.mjs
  node .build/scripts/test-storefront-data.mjs
  node .build/scripts/test-storefront.mjs
  node .build/scripts/test-interactions.mjs

Refresh before rendering: node .build/scripts/sync-catalog.mjs

GitHub Actions deploys main pushes, manual dispatches, and a daily refreshed build. Refreshed data is an artifact, not a commit. Failed refresh or validation leaves the last successful deployment. The browser also refreshes live inventory, and checkout rechecks exact variants, quantities, prices, and stock.

No secret API key is embedded. The explicit Storefront API version 2026-10 needs review before Shopify retires it. No payment, account sign-in, newsletter subscription, or recipient gift delivery was submitted during QA.

Original first-party logo and store imagery are preserved. Font licenses are in licenses/.

November 4, 2026 owner review: 249 products, 253 variants, 31 collections at the recorded source fetch. More readable business identity, newest arrivals, verified Readers Choice recognition, gallery values, clearer item/transport details, resilient live refresh, and stricter price review. Counts and availability remain time-specific.
