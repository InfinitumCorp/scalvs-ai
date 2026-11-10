# SCALVS.ai mirror (for networks that block Cloudflare)

Some networks — notably in Russia — throttle connections to Cloudflare, so
https://scalvs.app stalls there. The mirror is a small reverse proxy on Google
Cloud Run (`cloudrun/server.mjs`, project `scalvs-mirror`, region
`europe-north1`) that fetches everything from scalvs.app, so visitors on those
networks only talk to Google. Measured from a Russian network: scalvs.app stalled,
while `*.run.app` loaded in about half a second.

Mirror URL: https://scalvs-mirror-325535919239.europe-north1.run.app

- **Origin:** `scalvs.app` over HTTPS. No copy of the site is kept; every deploy of
  scalvs.app shows up on the mirror at once.
- **Headers:** the browser's `Origin` and `Referer` are not forwarded, so the API's
  cross-site checks pass; cookies, query strings and the usual content headers are.
  `Domain=` is removed from cookies so they stick to the mirror host.
- **Redirects:** `Location: https://scalvs.app/...` is rewritten to the mirror host.
- **Streaming:** answers (server-sent events) are streamed chunk by chunk; the
  request timeout is 300 seconds.

The phone app (`mobile/`) tries scalvs.app and the mirror at start-up and opens
whichever fully loads a 28 KB file first.

Deploy (needs public access, because the mirror is a public website):

```bash
gcloud run deploy scalvs-mirror --source mirror/cloudrun --project=scalvs-mirror --region=europe-north1 --allow-unauthenticated --min-instances=0 --max-instances=2 --timeout=300 --memory=256Mi
```

Known limit: connector sign-ins (OAuth) send you back to scalvs.app, because the
site builds its sign-in return address from the host it is served on, and the
mirror reaches it as scalvs.app. On a blocked network, connectors that need a
sign-in (Notion, GitHub OAuth and so on) need a VPN. Everything else, including
connectors that use a pasted token, works on the mirror.

Cost: inside the Cloud Run free tier (2M requests, 180,000 vCPU-seconds and
360,000 GiB-seconds a month). It scales to zero when idle, and `--max-instances=2`
caps it. The rate limiter on scalvs.app keys on the visitor IP; behind the mirror
all visitors share Google's egress IPs, so heavy mirror use could hit that limit.

`rewrite-location.js` is the earlier CloudFront version (AWS needs account
verification before it allows a distribution).
