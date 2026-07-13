/**
 * Real UA + Client Hints generator
 * Covers: desktop Chrome/Edge, desktop Safari, Android Chrome, iOS Safari
 * Chrome version live from chromiumdash (cached). Safari/iOS from verified 2026 baselines.
 */

const https = require('https');

const DASH_WIN =
    'https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=1&offset=0';
const DASH_ANDROID =
    'https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Android&num=1&offset=0';

// Last verified 2026-07-13
// Apple developer releases list iOS/iPadOS 26.5–26.6 + 27.0; Safari 26 on macOS Tahoe
const FALLBACK = {
    chrome: { major: 150, full: '150.0.7871.115', branch: '7871' },
    android: { major: 150, full: '150.0.7871.64', branch: '7871' },
    safari: {
        // Version/ in UA tracks Safari major (26 / 27)
        versions: [
            { version: '27.0', weight: 12 },
            { version: '26.5', weight: 28 },
            { version: '26.4', weight: 22 },
            { version: '26.3', weight: 16 },
            { version: '26.2', weight: 12 },
            { version: '26.1', weight: 6 },
            { version: '26.0', weight: 4 },
        ],
        webkit: '605.1.15',
        safariBuild: '605.1.15',
    },
    ios: {
        // Weighted OS majors — developer.apple.com/news/releases (2026-07)
        majors: [
            { major: 27, weight: 14, patches: ['0'] },
            { major: 26, weight: 70, patches: ['6', '5', '4', '3', '2', '1', '0'] },
            { major: 18, weight: 16, patches: ['7', '6', '5'] }, // older still-supported fleet
        ],
        webkit: '605.1.15',
        mobileBuild: '15E148',
    },
    macos: {
        // Live Safari UAs use real macOS tokens (e.g. 15_7_x Sequoia, 26_x Tahoe)
        tokens: [
            { token: '15_7_7', weight: 28 },
            { token: '15_7_6', weight: 14 },
            { token: '15_6_1', weight: 10 },
            { token: '15_5', weight: 8 },
            { token: '26_0', weight: 18 },
            { token: '26_1', weight: 12 },
            { token: '26_2', weight: 6 },
            { token: '14_7_6', weight: 4 }, // Sonoma tail
        ],
    },
};

const TTL_MS = 6 * 60 * 60 * 1000;

let cache = {
    chrome: { ...FALLBACK.chrome, fetchedAt: 0 },
    android: { ...FALLBACK.android, fetchedAt: 0 },
};

// ── Desktop Chromium platforms ──────────────────────────────────────────────
const DESKTOP_CHROME_PLATFORMS = [
    {
        id: 'win11',
        weight: 40,
        osToken: 'Windows NT 10.0; Win64; x64',
        platformHint: '"Windows"',
        arch: 'x86',
        bitness: '64',
    },
    {
        id: 'win10',
        weight: 14,
        osToken: 'Windows NT 10.0; Win64; x64',
        platformHint: '"Windows"',
        arch: 'x86',
        bitness: '64',
    },
    {
        id: 'mac-arm',
        weight: 14,
        osToken: 'Macintosh; Intel Mac OS X 10_15_7',
        platformHint: '"macOS"',
        arch: 'arm',
        bitness: '64',
        mac: true,
    },
    {
        id: 'mac-intel',
        weight: 6,
        osToken: 'Macintosh; Intel Mac OS X 10_15_7',
        platformHint: '"macOS"',
        arch: 'x86',
        bitness: '64',
        mac: true,
    },
    {
        id: 'linux',
        weight: 8,
        osToken: 'X11; Linux x86_64',
        platformHint: '"Linux"',
        arch: 'x86',
        bitness: '64',
    },
    {
        id: 'chromeos',
        weight: 4,
        osToken: 'X11; CrOS x86_64 14541.0.0',
        platformHint: '"Chrome OS"',
        arch: 'x86',
        bitness: '64',
    },
];

// ── Desktop Safari (real WebKit — not Chrome-on-Mac) ────────────────────────
// osToken built at generate-time from FALLBACK.macos (current Sequoia 15 / Tahoe 26)
const DESKTOP_SAFARI_PLATFORMS = [
    { id: 'safari-mac-arm', weight: 78, platformHint: '"macOS"', arch: 'arm' },
    { id: 'safari-mac-intel', weight: 22, platformHint: '"macOS"', arch: 'x86' },
];

// ── Android devices (API levels live as of 2026-07: 14–17 on developer.android.com)
// Prefer current majors; keep a thin tail of 14 for older fleet realism.
const ANDROID_DEVICES = [
    { id: 'pixel-10', weight: 14, model: 'Pixel 10', android: '17' },
    { id: 'pixel-9', weight: 16, model: 'Pixel 9', android: '16' },
    { id: 'pixel-9-pro', weight: 10, model: 'Pixel 9 Pro', android: '16' },
    { id: 'pixel-8', weight: 8, model: 'Pixel 8', android: '15' },
    { id: 'samsung-s26', weight: 12, model: 'SM-S941B', android: '17' },
    { id: 'samsung-s25', weight: 14, model: 'SM-S931B', android: '16' },
    { id: 'samsung-s24', weight: 8, model: 'SM-S921B', android: '15' },
    { id: 'samsung-a56', weight: 8, model: 'SM-A566B', android: '16' },
    { id: 'xiaomi-15', weight: 6, model: '2410DPN6CC', android: '16' },
    { id: 'oneplus-13', weight: 5, model: 'CPH2649', android: '16' },
    { id: 'generic-16', weight: 3, model: 'K', android: '16' },
    { id: 'generic-15', weight: 2, model: 'K', android: '15' },
    { id: 'legacy-14', weight: 2, model: 'Pixel 7', android: '14' },
];

// ── iOS / iPadOS devices (model labels for meta; UA only exposes iPhone/iPad) ─
const IOS_DEVICES = [
    { id: 'iphone-17', weight: 18, device: 'iPhone', osToken: 'iPhone' },
    { id: 'iphone-16-pro', weight: 16, device: 'iPhone', osToken: 'iPhone' },
    { id: 'iphone-16', weight: 14, device: 'iPhone', osToken: 'iPhone' },
    { id: 'iphone-15', weight: 12, device: 'iPhone', osToken: 'iPhone' },
    { id: 'iphone-14', weight: 8, device: 'iPhone', osToken: 'iPhone' },
    { id: 'iphone-se', weight: 4, device: 'iPhone', osToken: 'iPhone' },
    { id: 'ipad-pro-m4', weight: 12, device: 'iPad', osToken: 'iPad' },
    { id: 'ipad-air', weight: 8, device: 'iPad', osToken: 'iPad' },
    { id: 'ipad-mini', weight: 4, device: 'iPad', osToken: 'iPad' },
    { id: 'ipad', weight: 4, device: 'iPad', osToken: 'iPad' },
];

const LOCALES = [
    { lang: 'en-US,en;q=0.9', weight: 38 },
    { lang: 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7', weight: 16 },
    { lang: 'en-GB,en;q=0.9', weight: 10 },
    { lang: 'es-ES,es;q=0.9,en;q=0.8', weight: 8 },
    { lang: 'es-MX,es;q=0.9,en;q=0.8', weight: 6 },
    { lang: 'fr-FR,fr;q=0.9,en;q=0.8', weight: 5 },
    { lang: 'de-DE,de;q=0.9,en;q=0.8', weight: 5 },
    { lang: 'ja-JP,ja;q=0.9,en;q=0.8', weight: 4 },
    { lang: 'zh-CN,zh;q=0.9,en;q=0.8', weight: 4 },
    { lang: 'ko-KR,ko;q=0.9,en;q=0.8', weight: 2 },
    { lang: 'it-IT,it;q=0.9,en;q=0.8', weight: 2 },
];

const GREASE = [
    { brand: 'Not.A/Brand', v: '8' },
    { brand: 'Not_A Brand', v: '24' },
    { brand: 'Not A(Brand', v: '99' },
    { brand: 'Not)A;Brand', v: '99' },
];

// Typical mobile viewports for puppeteer
const VIEWPORTS = {
    'android-phone': { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, isLandscape: false },
    'iphone': { width: 393, height: 852, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: false },
    'ipad': { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false },
    'desktop': { width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false, hasTouch: false, isLandscape: true },
};

function pickWeighted(items) {
    const total = items.reduce((s, i) => s + (i.weight || 1), 0);
    let r = Math.random() * total;
    for (const item of items) {
        r -= item.weight || 1;
        if (r <= 0) return item;
    }
    return items[items.length - 1];
}

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function fetchJson(url, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: timeoutMs }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (raw += c));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(raw));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
    });
}

function parseVersion(full) {
    const m = String(full).match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return null;
    return { major: +m[1], minor: +m[2], build: +m[3], patch: +m[4], full };
}

async function refreshChrome(force = false) {
    if (!force && Date.now() - cache.chrome.fetchedAt < TTL_MS) return getVersion();
    try {
        const data = await fetchJson(DASH_WIN);
        const row = Array.isArray(data) ? data[0] : null;
        const parsed = row && parseVersion(row.version);
        if (parsed) {
            cache.chrome = {
                major: parsed.major,
                full: parsed.full,
                branch: String(parsed.build),
                fetchedAt: Date.now(),
            };
        }
    } catch (_) {
        if (!cache.chrome.fetchedAt) cache.chrome.fetchedAt = Date.now();
    }
    return getVersion();
}

async function refreshAndroid(force = false) {
    if (!force && Date.now() - cache.android.fetchedAt < TTL_MS) {
        return {
            major: cache.android.major,
            full: cache.android.full,
            branch: cache.android.branch,
            reduced: `${cache.android.major}.0.0.0`,
            fetchedAt: cache.android.fetchedAt,
        };
    }
    try {
        const data = await fetchJson(DASH_ANDROID);
        const row = Array.isArray(data) ? data[0] : null;
        const parsed = row && parseVersion(row.version);
        if (parsed) {
            cache.android = {
                major: parsed.major,
                full: parsed.full,
                branch: String(parsed.build),
                fetchedAt: Date.now(),
            };
        }
    } catch (_) {
        if (!cache.android.fetchedAt) cache.android.fetchedAt = Date.now();
    }
    return {
        major: cache.android.major,
        full: cache.android.full,
        branch: cache.android.branch,
        reduced: `${cache.android.major}.0.0.0`,
        fetchedAt: cache.android.fetchedAt,
    };
}

/** Refresh desktop + android chrome versions from web */
async function refresh(force = false) {
    const [desktop, android] = await Promise.all([refreshChrome(force), refreshAndroid(force)]);
    return { desktop, android, safari: FALLBACK.safari, ios: FALLBACK.ios };
}

function getVersion() {
    return {
        major: cache.chrome.major,
        full: cache.chrome.full,
        branch: cache.chrome.branch,
        reduced: `${cache.chrome.major}.0.0.0`,
        fetchedAt: cache.chrome.fetchedAt,
        android: {
            major: cache.android.major,
            full: cache.android.full,
            reduced: `${cache.android.major}.0.0.0`,
        },
        safari: FALLBACK.safari,
        ios: FALLBACK.ios,
        macos: FALLBACK.macos,
    };
}

function nearbyFull(baseFull) {
    const base = parseVersion(baseFull);
    if (!base) return baseFull;
    const patch = Math.max(0, base.patch + randInt(-6, 3));
    return `${base.major}.${base.minor}.${base.build}.${patch}`;
}

function greaseBrand() {
    return GREASE[randInt(0, GREASE.length - 1)];
}

function brandList(major, kind = 'chrome') {
    const g = greaseBrand();
    if (kind === 'edge') {
        return [
            { brand: g.brand, version: g.v },
            { brand: 'Chromium', version: String(major) },
            { brand: 'Microsoft Edge', version: String(major) },
        ];
    }
    return [
        { brand: g.brand, version: g.v },
        { brand: 'Chromium', version: String(major) },
        { brand: 'Google Chrome', version: String(major) },
    ];
}

function formatSecChUa(brands) {
    return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}

function formatFullVersionList(brands, full) {
    return brands
        .map((b) => {
            if (b.brand.startsWith('Not')) return `"${b.brand}";v="${b.version}.0.0.0"`;
            return `"${b.brand}";v="${full}"`;
        })
        .join(', ');
}

function safariVersionString() {
    return pickWeighted(FALLBACK.safari.versions).version;
}

function macosToken() {
    return pickWeighted(FALLBACK.macos.tokens).token;
}

/**
 * iOS/iPadOS UA version parts.
 * Live fleet (2026-07): 26.x dominant, 27.0 rolling out, 18.x still on older hardware.
 * Safari Version/ often tracks 26.x even when OS is 18.x on lagged whatismybrowser samples;
 * we pair Version/ with OS major when on 26/27, and Safari 26 when OS is 18.
 */
function iosVersionParts() {
    const row = pickWeighted(FALLBACK.ios.majors);
    const major = row.major;
    const minor = Number(row.patches[randInt(0, row.patches.length - 1)]);
    // occasional micro patch for realism (26_5_1 style)
    const micro = Math.random() < 0.25 && minor > 0 ? randInt(1, 3) : 0;

    let osToken;
    let version;
    if (micro > 0) {
        osToken = `${major}_${minor}_${micro}`;
        version = `${major}.${minor}.${micro}`;
    } else if (minor > 0) {
        osToken = `${major}_${minor}`;
        version = `${major}.${minor}`;
    } else {
        osToken = `${major}_0`;
        version = `${major}.0`;
    }

    // Safari Version/ in UA
    let safariVer;
    if (major >= 26) {
        safariVer = micro > 0 ? `${major}.${minor}` : version;
        // keep Version/ as N.M (Safari style)
        if (micro > 0) safariVer = `${major}.${minor}`;
    } else {
        // older OS still shipping Safari 26 UI version in many captures
        safariVer = safariVersionString();
    }

    return { osToken, version, major, minor, micro, safariVer };
}

/**
 * Pick browser family
 * @param {object} opts
 * @param {'desktop'|'mobile'|null} opts.device
 * @param {'chrome'|'edge'|'safari'|null} opts.browser
 * @param {boolean|null} opts.mobile - alias for device:mobile
 */
function resolveKind(opts = {}) {
    let device = opts.device || null;
    if (opts.mobile === true) device = 'mobile';
    if (opts.mobile === false) device = 'desktop';

    let browser = opts.browser || null;

    if (!device && !browser) {
        // weighted real-world-ish mix
        const roll = Math.random();
        if (roll < 0.55) return { device: 'desktop', browser: 'chrome' };
        if (roll < 0.63) return { device: 'desktop', browser: 'edge' };
        if (roll < 0.72) return { device: 'desktop', browser: 'safari' };
        if (roll < 0.90) return { device: 'mobile', browser: 'chrome' }; // android
        return { device: 'mobile', browser: 'safari' }; // ios
    }

    if (!device) {
        if (browser === 'edge') device = 'desktop';
        else device = Math.random() < 0.65 ? 'desktop' : 'mobile';
    }

    if (!browser) {
        if (device === 'mobile') browser = Math.random() < 0.62 ? 'chrome' : 'safari';
        else {
            const r = Math.random();
            browser = r < 0.78 ? 'chrome' : r < 0.90 ? 'edge' : 'safari';
        }
    }

    // Edge is desktop-only here
    if (browser === 'edge') device = 'desktop';
    // Android chrome vs iOS safari: chrome on mobile => android; safari on mobile => ios
    return { device, browser };
}

function generateDesktopChrome(opts = {}) {
    const ver = getVersion();
    const major = ver.major;
    const full = opts.fullVersion || nearbyFull(ver.full);
    const reduced = `${major}.0.0.0`;
    const isEdge = opts.browser === 'edge';
    const platform =
        (opts.platform && DESKTOP_CHROME_PLATFORMS.find((p) => p.id === opts.platform)) ||
        pickWeighted(DESKTOP_CHROME_PLATFORMS);
    const brands = brandList(major, isEdge ? 'edge' : 'chrome');
    const locale = pickWeighted(LOCALES);

    let ua = `Mozilla/5.0 (${platform.osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reduced} Safari/537.36`;
    if (isEdge) ua += ` Edg/${reduced}`;

    const headers = {
        'User-Agent': ua,
        'Accept-Language': locale.lang,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'sec-ch-ua': formatSecChUa(brands),
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': platform.platformHint,
        'sec-ch-ua-platform-version': platform.mac
            ? `"${randInt(14, 15)}.${randInt(0, 5)}.${randInt(0, 5)}"`
            : platform.id.startsWith('win')
              ? `"${randInt(10, 15)}.0.0"`
              : '""',
        'sec-ch-ua-full-version-list': formatFullVersionList(brands, full),
        'sec-ch-ua-arch': `"${platform.arch}"`,
        'sec-ch-ua-bitness': `"${platform.bitness || '64'}"`,
        'Upgrade-Insecure-Requests': '1',
    };

    return {
        ua,
        headers,
        viewport: { ...VIEWPORTS.desktop },
        meta: {
            device: 'desktop',
            browser: isEdge ? 'edge' : 'chrome',
            engine: 'blink',
            platform: platform.id,
            major,
            full,
            reduced,
            locale: locale.lang,
        },
    };
}

function generateDesktopSafari(opts = {}) {
    const platform =
        (opts.platform && DESKTOP_SAFARI_PLATFORMS.find((p) => p.id === opts.platform)) ||
        pickWeighted(DESKTOP_SAFARI_PLATFORMS);
    const ver = safariVersionString();
    const mac = macosToken();
    const wk = FALLBACK.safari.webkit;
    const locale = pickWeighted(LOCALES);
    const osToken = `Macintosh; Intel Mac OS X ${mac}`;

    // Real Safari UA — AppleWebKit/605.x, Version/N, Safari/605.x (NOT Chrome/…)
    const ua = `Mozilla/5.0 (${osToken}) AppleWebKit/${wk} (KHTML, like Gecko) Version/${ver} Safari/${wk}`;

    const headers = {
        'User-Agent': ua,
        'Accept-Language': locale.lang,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        // Safari does not send sec-ch-ua the same way; omit chromium client hints
        'Upgrade-Insecure-Requests': '1',
    };

    return {
        ua,
        headers,
        viewport: { ...VIEWPORTS.desktop },
        meta: {
            device: 'desktop',
            browser: 'safari',
            engine: 'webkit',
            platform: platform.id,
            macos: mac,
            safariVersion: ver,
            webkit: wk,
            locale: locale.lang,
        },
    };
}

function generateAndroidChrome(opts = {}) {
    const major = cache.android.major;
    const full = opts.fullVersion || nearbyFull(cache.android.full);
    const reduced = `${major}.0.0.0`;
    const device =
        (opts.platform && ANDROID_DEVICES.find((d) => d.id === opts.platform)) ||
        pickWeighted(ANDROID_DEVICES);
    const brands = brandList(major, 'chrome');
    const locale = pickWeighted(LOCALES);

    const ua = `Mozilla/5.0 (Linux; Android ${device.android}; ${device.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reduced} Mobile Safari/537.36`;

    const headers = {
        'User-Agent': ua,
        'Accept-Language': locale.lang,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'sec-ch-ua': formatSecChUa(brands),
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'sec-ch-ua-platform-version': `"${device.android}.0.0"`,
        'sec-ch-ua-full-version-list': formatFullVersionList(brands, full),
        'sec-ch-ua-model': `"${device.model}"`,
        'sec-ch-ua-arch': '""',
        'sec-ch-ua-bitness': '""',
        'Upgrade-Insecure-Requests': '1',
    };

    return {
        ua,
        headers,
        viewport: { ...VIEWPORTS['android-phone'] },
        meta: {
            device: 'mobile',
            browser: 'chrome',
            engine: 'blink',
            platform: device.id,
            model: device.model,
            android: device.android,
            major,
            full,
            reduced,
            locale: locale.lang,
        },
    };
}

function generateIOSSafari(opts = {}) {
    const device =
        (opts.platform && IOS_DEVICES.find((d) => d.id === opts.platform)) ||
        pickWeighted(IOS_DEVICES);
    const ios = iosVersionParts();
    const wk = FALLBACK.ios.webkit;
    const mobile = FALLBACK.ios.mobileBuild;
    const locale = pickWeighted(LOCALES);

    // Real iOS Safari — no Chrome/ token
    // iPhone: "CPU iPhone OS 26_5 like Mac OS X"
    // iPad:   "CPU OS 26_5 like Mac OS X"
    const cpuToken =
        device.device === 'iPad'
            ? `CPU OS ${ios.osToken} like Mac OS X`
            : `CPU iPhone OS ${ios.osToken} like Mac OS X`;
    const ua = `Mozilla/5.0 (${device.osToken}; ${cpuToken}) AppleWebKit/${wk} (KHTML, like Gecko) Version/${ios.safariVer} Mobile/${mobile} Safari/604.1`;

    const headers = {
        'User-Agent': ua,
        'Accept-Language': locale.lang,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Upgrade-Insecure-Requests': '1',
    };

    const viewport = device.device === 'iPad' ? { ...VIEWPORTS.ipad } : { ...VIEWPORTS.iphone };

    return {
        ua,
        headers,
        viewport,
        meta: {
            device: 'mobile',
            browser: 'safari',
            engine: 'webkit',
            platform: device.id,
            appleDevice: device.device,
            ios: ios.version,
            safariVersion: ios.safariVer,
            webkit: wk,
            locale: locale.lang,
        },
    };
}

/**
 * Generate one realistic profile
 * @param {object} opts
 * @param {'desktop'|'mobile'} [opts.device]
 * @param {'chrome'|'edge'|'safari'} [opts.browser]
 * @param {boolean} [opts.mobile]
 * @param {string} [opts.platform] platform/device id
 * @param {string} [opts.fullVersion]
 */
function generate(opts = {}) {
    const kind = resolveKind(opts);

    if (kind.device === 'mobile' && kind.browser === 'safari') {
        return generateIOSSafari({ ...opts, browser: 'safari' });
    }
    if (kind.device === 'mobile' && kind.browser === 'chrome') {
        return generateAndroidChrome({ ...opts, browser: 'chrome' });
    }
    if (kind.device === 'desktop' && kind.browser === 'safari') {
        return generateDesktopSafari({ ...opts, browser: 'safari' });
    }
    // desktop chrome / edge
    return generateDesktopChrome({ ...opts, browser: kind.browser === 'edge' ? 'edge' : 'chrome' });
}

async function* infinite(opts = {}) {
    await refresh();
    while (true) {
        if (Date.now() - cache.chrome.fetchedAt >= TTL_MS) await refresh();
        yield generate(opts);
    }
}

function batch(n = 10, opts = {}) {
    return Array.from({ length: n }, () => generate(opts));
}

async function applyToPage(page, profile) {
    const p = profile || generate();
    await page.setUserAgent(p.ua);
    if (p.viewport) {
        await page.setViewport(p.viewport);
    }
    const { 'User-Agent': _ua, ...rest } = p.headers;
    await page.setExtraHTTPHeaders(rest);
    return p;
}

module.exports = {
    refresh,
    getVersion,
    generate,
    infinite,
    batch,
    applyToPage,
    VIEWPORTS,
    FALLBACK,
    DESKTOP_CHROME_PLATFORMS,
    DESKTOP_SAFARI_PLATFORMS,
    ANDROID_DEVICES,
    IOS_DEVICES,
};
