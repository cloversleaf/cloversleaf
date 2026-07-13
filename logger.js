/**
 * Structured logger for Railway / local
 * One JSON object per line → searchable in Railway logs
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const configured = (process.env.LOG_LEVEL || 'info').toLowerCase();
const minLevel = LEVELS[configured] ?? LEVELS.info;
const service = process.env.RAILWAY_SERVICE_NAME || process.env.SERVICE_NAME || 'cloversleaf';
const env = process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'development';

function base(level, msg, fields = {}) {
    if ((LEVELS[level] ?? 99) < minLevel) return;

    const line = {
        ts: new Date().toISOString(),
        level,
        service,
        env,
        msg,
        ...fields,
    };

    // never log secrets
    if (line.proxy) line.proxy = redactProxy(line.proxy);
    if (line.cookies) line.cookies = `[${String(line.cookies).split(';').length} cookies]`;
    if (line.html) line.html = `[html ${String(line.html).length}b]`;

    const out = JSON.stringify(line);
    if (level === 'error') console.error(out);
    else if (level === 'warn') console.warn(out);
    else console.log(out);
}

function redactProxy(p) {
    try {
        const u = new URL(p.includes('://') ? p : `http://${p}`);
        if (u.username || u.password) {
            u.username = u.username ? '***' : '';
            u.password = u.password ? '***' : '';
        }
        return u.toString();
    } catch {
        return '[proxy]';
    }
}

function child(bindings = {}) {
    return {
        debug: (msg, f) => base('debug', msg, { ...bindings, ...f }),
        info: (msg, f) => base('info', msg, { ...bindings, ...f }),
        warn: (msg, f) => base('warn', msg, { ...bindings, ...f }),
        error: (msg, f) => base('error', msg, { ...bindings, ...f }),
        child: (more) => child({ ...bindings, ...more }),
    };
}

const log = child();

module.exports = { log, child, redactProxy };
