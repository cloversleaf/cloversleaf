const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const ua = require('./ua');
const { log: defaultLog } = require('./logger');
puppeteer.use(StealthPlugin());

class cloverwaf {
    constructor(opts = {}) {
        this.headless = opts.headless ?? 'new';
        this.timeout = opts.timeout ?? 120000;
        this.retry = opts.retry ?? 5;
        this.proxy = opts.proxy || null;
        this.browser = null;
        this.sessions = new Map();
        this.log = opts.log || defaultLog;
    }

    async init() {
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-infobars',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
            '--no-first-run',
            '--disable-notifications',
            '--mute-audio',
            '--lang=pt-BR',
            '--window-size=1920,1080',
            '--window-position=0,0',
        ];

        if (this.proxy) {
            args.push(`--proxy-server=${this.proxy}`);
        }

        this.log.info('browser_launch', {
            headless: this.headless,
            proxy: this.proxy || null,
            chromePath: process.env.CHROME_PATH || 'bundled',
        });

        const t0 = Date.now();
        this.browser = await puppeteer.launch({
            headless: this.headless,
            executablePath: process.env.CHROME_PATH || undefined,
            args,
            ignoreDefaultArgs: ['--enable-automation'],
            defaultViewport: null,
        });
        this.log.info('browser_launched', { ms: Date.now() - t0 });
        return this;
    }

    async newPage(opts = {}) {
        if (!this.browser) throw new Error('Call init() first');

        const page = await this.browser.newPage();
        const session = Math.random().toString(36).slice(2, 10);

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });

            Object.defineProperty(navigator, 'plugins', {
                get: () => [
                    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
                ],
            });

            Object.defineProperty(navigator, 'languages', {
                get: () => ['pt-BR', 'pt', 'en-US', 'en'],
            });

            Object.defineProperty(navigator, 'platform', {
                get: () => 'Win32',
            });

            Object.defineProperty(navigator, 'hardwareConcurrency', {
                get: () => 8,
            });

            Object.defineProperty(navigator, 'deviceMemory', {
                get: () => 8,
            });

            Object.defineProperty(navigator, 'maxTouchPoints', {
                get: () => 0,
            });

            window.chrome = {
                runtime: { onConnect: { addListener: () => {} }, onMessage: { addListener: () => {} } },
                loadTimes: () => {},
                csi: () => {},
                app: {
                    isInstalled: false,
                    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
                    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
                },
                webstore: { onInstallStageChanged: {}, onDownloadProgress: {} },
            };

            const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
            window.navigator.permissions.query = (params) =>
                params.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission })
                    : originalQuery(params);

            const getParam = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function (p) {
                if (p === 37445) return 'Intel Inc.';
                if (p === 37446) return 'Intel Iris OpenGL Engine';
                return getParam.call(this, p);
            };

            const getContext = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type, ...args) {
                const ctx = getContext.call(this, type, ...args);
                if (ctx && type === '2d') {
                    const fillText = ctx.fillText.bind(ctx);
                    ctx.fillText = function (...a) {
                        ctx.shadowBlur = Math.random() * 0.000001;
                        return fillText(...a);
                    };
                }
                return ctx;
            };
        });

        await ua.refresh().catch(() => {});
        const profile = opts.ua
            ? {
                  ua: opts.ua,
                  headers: opts.headers || {},
                  viewport: null,
                  meta: {},
              }
            : ua.generate(opts.uaOpts || {});

        const vp = profile.viewport || {};
        await page.setViewport({
            width: opts.width || vp.width || 1920,
            height: opts.height || vp.height || 1080,
            deviceScaleFactor: opts.dpr || vp.deviceScaleFactor || 1,
            hasTouch: opts.touch ?? vp.hasTouch ?? false,
            isLandscape: opts.landscape ?? vp.isLandscape ?? true,
            isMobile: opts.mobile ?? vp.isMobile ?? false,
        });

        await page.setUserAgent(profile.ua);
        const { 'User-Agent': _drop, ...hintHeaders } = profile.headers || {};
        const headers = {
            'Accept-Language': hintHeaders['Accept-Language'] || 'en-US,en;q=0.9',
            Accept:
                hintHeaders.Accept ||
                'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Upgrade-Insecure-Requests': '1',
        };
        // Only Chromium browsers send sec-ch-ua*
        if (hintHeaders['sec-ch-ua']) {
            headers['sec-ch-ua'] = hintHeaders['sec-ch-ua'];
            headers['sec-ch-ua-mobile'] = hintHeaders['sec-ch-ua-mobile'] || '?0';
            headers['sec-ch-ua-platform'] = hintHeaders['sec-ch-ua-platform'] || '"Windows"';
        }
        await page.setExtraHTTPHeaders(headers);

        this.sessions.set(session, {
            page,
            cookies: null,
            html: null,
            time: Date.now(),
            ua: profile.ua,
            uaMeta: profile.meta || null,
        });
        return { page, session, profile };
    }

    async bypass(url, opts = {}) {
        const reqId = opts.reqId || null;
        const slog = this.log.child({ reqId, url });
        const { page, session, profile } = await this.newPage(opts);
        const start = Date.now();
        let lastError = 'Max retries';

        slog.info('bypass_start', {
            session,
            uaBrowser: profile?.meta?.browser,
            uaDevice: profile?.meta?.device,
            retryMax: this.retry,
        });

        for (let i = 1; i <= this.retry; i++) {
            try {
                slog.debug('goto', { attempt: i });
                await page.goto(url, {
                    waitUntil: opts.waitUntil || 'networkidle2',
                    timeout: opts.timeout || this.timeout,
                    referer: opts.referer || undefined,
                });

                slog.debug('solve_start', { attempt: i });
                await this.solve(page, opts.timeout || this.timeout);

                const clean = await this.isClean(page);
                slog.debug('clean_check', { attempt: i, clean, title: await page.title().catch(() => '') });

                if (clean) {
                    const cookies = await page.cookies();
                    const html = await page.content();
                    const elapsed = ((Date.now() - start) / 1000).toFixed(2);

                    const data = {
                        ok: true,
                        session,
                        cookies: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
                        cookiesJSON: cookies,
                        html,
                        time: elapsed + 's',
                        page,
                    };

                    this.sessions.set(session, { ...this.sessions.get(session), ...data });
                    slog.info('bypass_success', {
                        session,
                        attempt: i,
                        time: data.time,
                        cookieCount: cookies.length,
                        htmlBytes: html.length,
                    });
                    return data;
                }

                lastError = 'Challenge still present after solve';
                slog.warn('still_challenged', { attempt: i });
            } catch (e) {
                lastError = e.message;
                slog.warn('attempt_error', { attempt: i, error: e.message });
                if (i === this.retry) break;
                await this.sleep(2000 * i);
            }
        }

        await page.close().catch(() => {});
        this.sessions.delete(session);
        slog.error('bypass_failed', { session, error: lastError, ms: Date.now() - start });
        return { ok: false, error: lastError, session };
    }

    async solve(page, timeout) {
        const start = Date.now();

        while (Date.now() - start < timeout) {
            if (await this.isClean(page)) return;

            try {
                const frames = page.frames();
                for (const frame of frames) {
                    const furl = frame.url();
                    if (
                        furl.includes('challenges.cloudflare.com') ||
                        furl.includes('turnstile') ||
                        furl.includes('recaptcha')
                    ) {
                        await frame
                            .evaluate(() => {
                                const targets = document.querySelectorAll(
                                    '.cf-turnstile, .g-recaptcha, #challenge-stage, input[type="checkbox"], button'
                                );
                                targets.forEach((el) => {
                                    try {
                                        el.click();
                                        el.focus();
                                    } catch (_) {}
                                });
                            })
                            .catch(() => {});
                    }
                }
            } catch (_) {}

            try {
                await page.evaluate(() => {
                    document
                        .querySelectorAll('iframe, .cf-turnstile, .g-recaptcha, #challenge-stage, #challenge-form')
                        .forEach((el) => {
                            try {
                                el.click();
                                el.focus();
                            } catch (_) {}
                        });
                    window.scrollBy(0, Math.random() * 120 - 60);
                });
            } catch (_) {}

            try {
                const x = Math.random() * 800 + 200;
                const y = Math.random() * 500 + 100;
                await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 8) + 4 });
            } catch (_) {}

            await this.sleep(1500);
        }
    }

    async isClean(page) {
        try {
            const title = (await page.title().catch(() => '')).toLowerCase();
            const url = page.url().toLowerCase();

            const challengeTitles = [
                'just a moment',
                'attention required',
                'checking your browser',
                'please wait',
                'security check',
                'access denied',
                'ddos protection',
                'one more step',
            ];
            if (challengeTitles.some((t) => title.includes(t))) return false;

            if (
                url.includes('challenges.cloudflare.com') ||
                url.includes('/cdn-cgi/challenge') ||
                url.includes('captcha')
            ) {
                return false;
            }

            const signals = await page.evaluate(() => {
                const html = document.documentElement.innerHTML;
                const bodyText = (document.body && document.body.innerText) || '';

                const challengeDom = !!(
                    document.querySelector('#challenge-form') ||
                    document.querySelector('#challenge-stage') ||
                    document.querySelector('.cf-browser-verification') ||
                    document.querySelector('#cf-challenge-running') ||
                    document.querySelector('.cf-turnstile') ||
                    document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
                    document.querySelector('iframe[src*="turnstile"]') ||
                    document.querySelector('iframe[src*="recaptcha"]') ||
                    document.querySelector('#px-captcha') ||
                    document.querySelector('[data-translate="checking_browser"]')
                );

                const challengeMarkers = [
                    'cf-browser-verification',
                    'cf_chl_opt',
                    'cf-challenge-running',
                    'challenges.cloudflare.com/turnstile',
                    'cdn-cgi/challenge-platform',
                    'sucuri_cloudproxy',
                    '_incapsula_resource',
                    'perimeterx',
                    'px-captcha',
                    'datadome',
                ];

                const hasMarker = challengeMarkers.some((m) => html.toLowerCase().includes(m));

                const shortInterstitial =
                    bodyText.length < 400 &&
                    /checking your browser|just a moment|enable javascript and cookies|ddos protection by/i.test(
                        bodyText
                    );

                return { challengeDom, hasMarker, shortInterstitial };
            });

            if (signals.challengeDom || signals.hasMarker || signals.shortInterstitial) return false;
            return true;
        } catch (_) {
            return false;
        }
    }

    getSession(session) {
        return this.sessions.get(session) || null;
    }

    sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    async close() {
        this.log.info('browser_closing', { sessions: this.sessions.size });
        for (const [, data] of this.sessions) {
            if (data.page) await data.page.close().catch(() => {});
        }
        this.sessions.clear();
        if (this.browser) await this.browser.close().catch(() => {});
        this.browser = null;
        this.log.info('browser_closed');
    }
}

module.exports = cloverwaf;
