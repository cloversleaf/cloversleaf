const express = require('express');
const crypto = require('crypto');
const cloverwaf = require('./cloud');
const { log } = require('./logger');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const bypass = new cloverwaf({
    headless: process.env.HEADLESS === 'false' ? false : 'new',
    timeout: Number(process.env.TIMEOUT) || 120000,
    retry: Number(process.env.RETRY) || 5,
    proxy: process.env.PROXY || null,
    log,
});

let ready = false;
let bootError = null;
const startedAt = Date.now();

// ── request logging ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
    const reqId = req.headers['x-request-id'] || crypto.randomBytes(6).toString('hex');
    req.reqId = reqId;
    res.setHeader('x-request-id', reqId);
    const t0 = Date.now();

    res.on('finish', () => {
        log.info('http', {
            reqId,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            ms: Date.now() - t0,
            ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
            ua: req.headers['user-agent']?.slice(0, 120),
        });
    });
    next();
});

app.use(express.json({ limit: '32kb' }));

// ── boot browser ────────────────────────────────────────────────────────────
(async () => {
    log.info('boot_start', {
        port: PORT,
        host: HOST,
        headless: process.env.HEADLESS !== 'false',
        timeout: Number(process.env.TIMEOUT) || 120000,
        retry: Number(process.env.RETRY) || 5,
        proxy: process.env.PROXY || null,
        node: process.version,
        railway: Boolean(process.env.RAILWAY_ENVIRONMENT_ID),
    });
    try {
        await bypass.init();
        ready = true;
        log.info('boot_ready', { ms: Date.now() - startedAt });
    } catch (e) {
        bootError = e.message;
        log.error('boot_failed', { error: e.message, stack: e.stack?.split('\n').slice(0, 4) });
        process.exit(1);
    }
})();

// ── routes ──────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    const body = {
        status: ready ? 'online' : bootError ? 'error' : 'starting',
        uptime_s: Math.floor((Date.now() - startedAt) / 1000),
        sessions: bypass.sessions?.size ?? 0,
    };
    if (bootError) body.error = bootError;
    res.status(ready ? 200 : bootError ? 500 : 503).json(body);
});

app.get('/bypass', async (req, res) => {
    const reqId = req.reqId;

    if (!ready) {
        log.warn('bypass_not_ready', { reqId });
        return res.status(503).json({ ok: false, error: 'Browser not ready', reqId });
    }

    const { url } = req.query;
    if (!url) {
        return res.status(400).json({ ok: false, error: 'Query param "url" is required', reqId });
    }

    try {
        new URL(url);
    } catch {
        log.warn('bypass_bad_url', { reqId, url: String(url).slice(0, 200) });
        return res.status(400).json({ ok: false, error: 'Invalid url', reqId });
    }

    const t0 = Date.now();
    log.info('bypass_request', { reqId, url });

    try {
        const result = await bypass.bypass(url, { reqId });
        log.info(result.ok ? 'bypass_ok' : 'bypass_fail', {
            reqId,
            url,
            ok: result.ok,
            session: result.session,
            time: result.time || null,
            error: result.error || null,
            ms: Date.now() - t0,
            cookieCount: result.cookies ? result.cookies.split(';').length : 0,
        });

        res.json({
            ok: result.ok,
            cookies: result.cookies || null,
            time: result.time || null,
            session: result.session,
            error: result.error || null,
            reqId,
        });
    } catch (e) {
        log.error('bypass_exception', {
            reqId,
            url,
            error: e.message,
            stack: e.stack?.split('\n').slice(0, 5),
            ms: Date.now() - t0,
        });
        res.status(500).json({ ok: false, error: e.message, reqId });
    }
});

app.get('/session/:id', (req, res) => {
    const data = bypass.getSession(req.params.id);
    if (!data) {
        log.warn('session_miss', { reqId: req.reqId, session: req.params.id });
        return res.status(404).json({ error: 'Session not found', reqId: req.reqId });
    }
    log.info('session_hit', { reqId: req.reqId, session: req.params.id });
    res.json({
        cookies: data.cookies || null,
        time: data.time || null,
        session: req.params.id,
        reqId: req.reqId,
    });
});

// ── listen ──────────────────────────────────────────────────────────────────
const server = app.listen(PORT, HOST, () => {
    log.info('listen', { host: HOST, port: PORT });
});

async function shutdown(signal) {
    log.info('shutdown', { signal });
    server.close();
    try {
        await bypass.close();
        log.info('browser_closed');
    } catch (e) {
        log.error('browser_close_error', { error: e.message });
    }
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
    log.error('uncaughtException', { error: e.message, stack: e.stack?.split('\n').slice(0, 6) });
});
process.on('unhandledRejection', (e) => {
    log.error('unhandledRejection', { error: e?.message || String(e) });
});
