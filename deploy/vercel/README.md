# The Vercel front door

`coldthecompany.vercel.app` is a Vercel project that holds only this
`vercel.json`: it forwards every request to COLD on Railway
(`coldthecompany.up.railway.app`), so visitors keep the Vercel address. COLD on
Railway runs with `COLD_PUBLIC_URL=https://coldthecompany.vercel.app` and
`COLD_PROXY_HOPS=2`. See docs/deploy.md.
