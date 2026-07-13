const express = require('express');
const cloverwaf = require('./cloud');

const app = express();
const PORT = process.env.PORT || 3000;

const bypass = new cloverwaf({
    headless: process.env.HEADLESS === 'false' ? false : 'new',
    timeout: Number(process.env.TIMEOUT) || 120000,
    retry: Number(process.env.RETRY) || 5,
    proxy: process.env.PROXY || null,
});

let ready = false;

(async () => {
    await bypass.init();
    ready = true;
    console.log('cloverwaf browser ready');
})().catch((e) => {
    console.error('Failed to init browser:', e.message);
    process.exit(1);
});

app.get('/health', (_req, res) => {
    res.json({ status: ready ? 'online' : 'starting' });
});

app.get('/bypass', async (req, res) => {
    if (!ready) return res.status(503).json({ ok: false, error: 'Browser not ready' });

    const { url } = req.query;
    if (!url) return res.status(400).json({ ok: false, error: 'Query param "url" is required' });

    try {
        new URL(url);
    } catch {
        return res.status(400).json({ ok: false, error: 'Invalid url' });
    }

    try {
        const result = await bypass.bypass(url);
        res.json({
            ok: result.ok,
            cookies: result.cookies || null,
            time: result.time || null,
            session: result.session,
            error: result.error || null,
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.get('/session/:id', (req, res) => {
    const data = bypass.getSession(req.params.id);
    if (!data) return res.status(404).json({ error: 'Session not found' });
    res.json({
        cookies: data.cookies || null,
        time: data.time || null,
        session: req.params.id,
    });
});

const server = app.listen(PORT, () => {
    console.log(`cloverwaf API on http://localhost:${PORT}`);
    console.log(`  GET /bypass?url=https://example.com`);
    console.log(`  GET /session/:id`);
    console.log(`  GET /health`);
});

async function shutdown() {
    console.log('Shutting down...');
    server.close();
    await bypass.close();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
