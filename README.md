# cloversleaf

Browser challenge engine for protected sites. Returns cookies + HTML after load.

**Stack:** Node 18+ · Puppeteer stealth · Express  
**Org:** [cloversleaf](https://github.com/cloversleaf)

## Install

```bash
git clone https://github.com/cloversleaf/cloversleaf.git
cd cloversleaf
npm install
```

## API

```bash
npm start
# http://localhost:3000
```

| Route | Description |
|-------|-------------|
| `GET /health` | `online` / `starting` |
| `GET /bypass?url=` | Run engine, return cookies |
| `GET /session/:id` | Stored session cookies |

```bash
curl "http://localhost:3000/bypass?url=https://example.com"
```

```json
{
  "ok": true,
  "cookies": "a=b; c=d",
  "time": "8.42s",
  "session": "a1b2c3d4",
  "error": null
}
```

## Library

```js
const cloverwaf = require('./cloud');

const engine = new cloverwaf({ headless: 'new', timeout: 120000, retry: 5 });
await engine.init();

const r = await engine.bypass('https://example.com', {
  // uaOpts: { device: 'mobile', browser: 'safari' },
});

if (r.ok) console.log(r.cookies, r.time);
await engine.close();
```

## Files

| File | Role |
|------|------|
| `cloud.js` | Engine (`cloverwaf`) |
| `ua.js` | UA / client-hints (desktop + mobile + Safari) |
| `server.js` | HTTP API |

## Env

| Variable | Default | Notes |
|----------|---------|--------|
| `PORT` | `3000` | API port |
| `HOST` | `0.0.0.0` | bind address |
| `HEADLESS` | `new` | set `false` to show browser |
| `TIMEOUT` | `120000` | ms |
| `RETRY` | `5` | attempts |
| `PROXY` | — | e.g. `http://host:port` |
| `CHROME_PATH` | — | system Chrome/Chromium |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

Logs are **JSON lines** (Railway-friendly): `boot_*`, `http`, `bypass_*`, `browser_*`.

## Railway

```bash
railway up
```

Uses `Dockerfile` (Puppeteer + Chrome). Set `PORT` automatically; optional `PROXY`, `LOG_LEVEL=info`.

## UA

```js
const ua = require('./ua');
await ua.refresh();

ua.generate({ device: 'desktop', browser: 'chrome' });
ua.generate({ device: 'desktop', browser: 'safari' });
ua.generate({ device: 'mobile', browser: 'chrome' });  // Android
ua.generate({ device: 'mobile', browser: 'safari' });  // iOS
```

Chrome major is pulled live from ChromiumDash.

## License

MIT · use only on targets you are allowed to test.
