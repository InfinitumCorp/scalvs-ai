// Browser config. `npm run build` rewrites this file in dist/ from environment
// variables (scripts/build-assets.mjs), and `npm run dev` serves it the same way,
// so a deployment can point at another revenue Worker without a code change.
//
//   REVENUE_URL  Infinitum revenue API (Stripe Checkout, portal, entitlements).
export const REVENUE_URL = 'https://infinitum-revenue.infinitumcorp.workers.dev';
