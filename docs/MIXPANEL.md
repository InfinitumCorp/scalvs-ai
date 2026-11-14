# Mixpanel on scalvs.app

Mixpanel for Startups (1 year free, up to 1B events/yr). Data must start flowing by about 12 Feb 2027.

- Web only: `index.html` loads `public/mixpanel.vendor.js` (first-party, no CDN) and `public/mixpanel-boot.js`.
- `npm run build` writes `dist/public/mixpanel-boot.js` from `MIXPANEL_PROJECT_TOKEN` (+ `MIXPANEL_REGION`, `MIXPANEL=off`).
  Set the token in the build environment (it is public, but keep it out of git). Without it, Mixpanel is off.
  Production builds run in `.github/workflows/auto-deploy.yml`, which reads the `MIXPANEL_PROJECT_TOKEN` repository secret
  (or variable) and `MIXPANEL_REGION` variable. A Worker secret alone does not reach the static files.
- Sends one `$mp_web_page_view` per load with `product: "scalvs"`, domain and path. No autocapture, session replay,
  IP geolocation, full URLs, query strings, referrers or UTM. Honors Global Privacy Control.
- Skipped inside the Android/iOS app, where the native Amplitude SDK already counts sessions (no double counting).
- The Chrome extension and its privacy page get no analytics.
- Rebuild the vendor file: `scripts/mixpanel-vendor/README.md`.
