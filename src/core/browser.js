'use strict';
const { chromium } = require('playwright');
const { Server } = require('proxy-chain');
const net = require('node:net');
const { STATUS, proxyUrl, validIp } = require('./model');

const LOGIN_URL = 'https://www.tiendanube.com/login';
const IP_URL = 'https://api.ipify.org?format=json';
const NETWORK_CODES = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/;
const SECURITY_TEXT = /(?:c[oó]digo.{0,35}(?:correo|email|e-mail|verific|autentic)|(?:enviamos|enviado).{0,40}c[oó]digo|verific[aá].{0,25}(?:identidad|correo|cuenta|humano)|autenticaci[oó]n.{0,15}(?:dos|2)|two.factor|one.time|captcha|confirma.{0,20}identidad|actividad sospechosa|demasiados intentos|too many requests|access denied|acceso denegado|verificaci[oó]n adicional|security check|verify.{0,20}(?:identity|human))/i;
const INVALID_TEXT = /(?:contrase[ñn]a.{0,20}incorrect|credenciales.{0,20}(?:incorrect|inv[aá]lid)|(?:e-?mail|correo).{0,25}(?:incorrect|no registrado)|no est[aá] registrada|no existe una tienda|tienda.{0,20}no existe|invalid (?:password|credentials)|incorrect password|cuenta.{0,20}(?:inexistente|desactivada|suspendida))/i;
const trustedHost = host => host === 'tiendanube.com' || host.endsWith('.tiendanube.com') || host.endsWith('.mitiendanube.com');
function classifyObservation({ text = '', url = '', status = 0, challenge = false, passwordVisible = false, dashboard = false }, account) {
  if (status === 403 || status === 429 || challenge || SECURITY_TEXT.test(text)) return { status: STATUS.MANUAL, reason: status === 403 || status === 429 ? `HTTP ${status}: acceso detenido; requiere revisión manual.` : 'Esta cuenta requiere validación manual.' };
  if (status >= 500) return { status: STATUS.TEMP, reason: 'El servicio devolvió un error temporal.' };
  if (INVALID_TEXT.test(text)) return { status: STATUS.INVALID, reason: 'El sitio indicó credenciales incorrectas, cuenta o tienda no disponible.' };
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  // A redirect alone is never proof of authentication. Require an authenticated
  // navigation element and the admin of the requested store, not another store.
  const matchingStore = account.store_url ? parsed.hostname === account.store_url : trustedHost(parsed.hostname);
  if (parsed.protocol === 'https:' && matchingStore && /^\/admin(?:\/|$)/.test(parsed.pathname) && !/login|signin|auth|verify|challenge/i.test(parsed.pathname) && dashboard && !passwordVisible) return { status: STATUS.VALID, reason: 'Panel autenticado de la tienda verificado.', store_url: parsed.hostname };
  return null;
}

async function bridge(proxy, type) {
  const upstreamProxyUrl = proxyUrl(proxy, type);
  let networkFailure = false;
  const server = new Server({ host: '127.0.0.1', port: 0, verbose: false, prepareRequestFunction: () => ({ upstreamProxyUrl }) });
  server.on('requestFailed', ({ error }) => { if (NETWORK_CODES.test(error?.code || '')) networkFailure = true; });
  server.on('tunnelConnectFailed', ({ error }) => { if (NETWORK_CODES.test(error?.code || '')) networkFailure = true; });
  await server.listen();
  return { server: `http://127.0.0.1:${server.port}`, networkFailed: () => networkFailure, close: () => server.close(true) };
}

function proxyReachable(proxy) {
  return new Promise(resolve => {
    const socket = net.connect({ host: proxy.host.replace(/^\[|\]$/g, ''), port: proxy.port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(5000, () => done(false));
  });
}

class BrowserService {
  constructor({ executablePath, profilePath, loginUrl = LOGIN_URL, ipUrl = IP_URL, diagnostics = () => {} }) {
    this.executablePath = executablePath; this.profilePath = profilePath; this.loginUrl = loginUrl; this.ipUrl = ipUrl; this.sessions = new Map(); this.diagnostics = diagnostics;
  }
  launchOptions(proxyServer, headless) {
    return { executablePath: this.executablePath, headless, proxy: { server: proxyServer }, timeout: 25000, args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] };
  }
  async probe(proxy, signal) {
    if (!await proxyReachable(proxy)) return { status: signal?.aborted ? 'SIN_COMPROBAR' : 'NO_FUNCIONA', connectivityFailed: true, ip: '', latency: null, checkedAt: new Date().toISOString() };
    const types = proxy.type ? [proxy.type] : ['http', 'https', 'socks5'];
    for (const type of types) {
      if (signal?.aborted) break;
      let relay, browser;
      const abort = () => { browser?.close().catch(() => {}); };
      try {
        relay = await bridge(proxy, type);
        browser = await chromium.launch(this.launchOptions(relay.server, true));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) throw new Error();
        const page = await browser.newPage();
        const started = Date.now();
        const response = await page.goto(this.ipUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        if (!response?.ok()) continue;
        const body = JSON.parse(await page.locator('body').innerText({ timeout: 2000 }));
        if (!validIp(body.ip)) continue;
        return { status: 'DISPONIBLE', connectivityFailed: false, type, ip: body.ip, latency: Date.now() - started, checkedAt: new Date().toISOString() };
      } catch { /* Never surface browser errors: they can contain credentials or URLs. */ }
      finally { signal?.removeEventListener('abort', abort); await browser?.close().catch(() => {}); await relay?.close().catch(() => {}); }
    }
    return { status: signal?.aborted ? 'SIN_COMPROBAR' : 'NO_FUNCIONA', connectivityFailed: false, ip: '', latency: null, checkedAt: new Date().toISOString() };
  }
  async open(account, proxy) {
    const existing = this.sessions.get(account.id);
    if (existing && !existing.page.isClosed()) { await existing.page.bringToFront(); return existing; }
    const relay = await bridge(proxy, proxy.type);
    let context;
    try {
      context = await chromium.launchPersistentContext(this.profilePath(account.id), { ...this.launchOptions(relay.server, false), viewport: null, acceptDownloads: false });
      const page = context.pages()[0] || await context.newPage();
      const session = { context, page, relay, submitted: false, security: false, mainStatus: 0, securityCode: 0 };
      const attach = tab => {
        tab.on('response', response => {
          try {
            const request = response.request();
            const url = new URL(response.url());
            const firstParty = trustedHost(url.hostname) || url.hostname === account.store_url;
            if (firstParty && [403, 429].includes(response.status()) && ['document', 'xhr', 'fetch'].includes(request.resourceType())) { session.security = true; session.securityCode = response.status(); }
            if (request.isNavigationRequest() && request.frame() === tab.mainFrame()) session.mainStatus = response.status();
          } catch { /* A frame may close between response and inspection. */ }
        });
      };
      attach(page); context.on('page', attach);
      context.once('close', () => { if (this.sessions.get(account.id) === session) this.sessions.delete(account.id); relay.close().catch(() => {}); });
      this.sessions.set(account.id, session);
      return session;
    } catch (e) { await context?.close().catch(() => {}); await relay.close().catch(() => {}); throw e; }
  }
  async observe(session, account) {
    if (session.security) return { status: STATUS.MANUAL, reason: session.securityCode ? `HTTP ${session.securityCode}: cuenta pausada; requiere intervención.` : 'Esta cuenta requiere validación manual.' };
    const page = session.page;
    const text = (await page.locator('body').innerText({ timeout: 2500 })).slice(0, 100000);
    const passwordVisible = await page.locator('input[type=password]:visible').count() > 0;
    const challenge = await page.locator('input[autocomplete=one-time-code]:visible, input[name*=otp i]:visible, iframe[src*="recaptcha"][title*="challenge" i]:visible, iframe[src*="hcaptcha"]:visible, iframe[src*="challenges.cloudflare.com"]:visible').count() > 0;
    const dashboard = await page.locator('a[href*="/admin/products"]:visible, a[href*="/admin/orders"]:visible, a[href*="/admin/logout"]:visible, a[href*="/admin/v2/products"]:visible, a[href*="/admin/v2/orders"]:visible').count() > 0;
    const result = classifyObservation({ text, url: page.url(), status: session.mainStatus, challenge, passwordVisible, dashboard }, account);
    if (result?.status === STATUS.MANUAL) session.security = true;
    return result;
  }
  async visible(page, selector) { const locator = page.locator(selector).first(); return await locator.isVisible().catch(() => false) ? locator : null; }
  async login(account, proxy, signal, progress) {
    let session;
    const stopped = () => signal?.aborted;
    try {
      progress('Abriendo perfil aislado…');
      session = await this.open(account, proxy);
      if (stopped()) return this.cancelResult();
      progress('Abriendo Tiendanube con la proxy asignada…');
      await session.page.goto(this.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const deadline = Date.now() + 60000;
      let emailFilled = false, passwordFilled = false, continued = false, choseStore = false;
      while (Date.now() < deadline) {
        const result = await this.observe(session, account);
        if (result) return result;
        if (stopped()) return this.cancelResult();
        const page = session.page;
        const url = new URL(page.url());
        // Never submit credentials to an unexpected origin, even after a redirect.
        if (!trustedHost(url.hostname) || url.protocol !== 'https:') return { status: STATUS.MANUAL, reason: 'Destino de autenticación no reconocido. Revisá la sesión manualmente.' };
        if (!session.submitted) {
          const email = await this.visible(page, 'input[type=email]:visible, input[name=email]:visible, input[name="user[email]"]:visible');
          const password = await this.visible(page, 'input[type=password]:visible');
          if (email && !emailFilled) { await email.fill(account.email); emailFilled = true; }
          if (password && emailFilled && !passwordFilled) { await password.fill(account.password); passwordFilled = true; }
          if (passwordFilled) {
            const securityBeforeSubmit = await this.observe(session, account);
            if (securityBeforeSubmit) return securityBeforeSubmit;
            if (stopped()) return this.cancelResult();
            progress('Iniciando sesión…');
            const submit = await this.visible(page, '#login-submit-btn:visible, button[type=submit]:visible, input[type=submit]:visible');
            session.submitted = true;
            if (submit) await submit.click({ timeout: 5000 }); else await password.press('Enter');
          } else if (emailFilled && !password && !continued) {
            const next = page.getByRole('button', { name: /^(continuar|siguiente|ingresar con e-mail)$/i }).first();
            if (await next.isVisible()) { continued = true; await next.click({ timeout: 5000 }); }
          } else if (!emailFilled && !continued) {
            const withEmail = page.getByRole('button', { name: /ingresar con e-mail|continuar con otra cuenta/i }).first();
            if (await withEmail.isVisible()) { continued = true; await withEmail.click({ timeout: 5000 }); }
          }
        }
        if (!choseStore && /seleccion[aá].{0,10}tienda/i.test(await page.locator('body').innerText())) {
          const anchors = await page.locator('a[href]').all();
          for (const anchor of anchors) {
            const href = await anchor.getAttribute('href');
            let target;
            try { target = new URL(href, page.url()); } catch { continue; }
            if (target.protocol === 'https:' && target.hostname === account.store_url && /^\/admin(?:\/|$)/.test(target.pathname) && await anchor.isVisible()) { choseStore = true; await anchor.click({ timeout: 5000 }); break; }
          }
        }
        await page.waitForTimeout(700);
      }
      return { status: STATUS.MANUAL, reason: 'Pantalla no reconocida o tienda pendiente de seleccionar. Revisá la sesión manualmente.' };
    } catch (error) {
      // Diagnostics expose only an allowlisted category, never raw page/errors.
      this.diagnostics({ category: /Target.*closed|has been closed/.test(error.message) ? 'BROWSER_CLOSED' : /Execution context was destroyed/.test(error.message) ? 'NAVIGATION_RACE' : error.name === 'TimeoutError' ? 'TIMEOUT' : 'OTHER' });
      if (session?.security) return { status: STATUS.MANUAL, reason: 'Control de seguridad detectado. Esta cuenta requiere validación manual.' };
      if (stopped()) return this.cancelResult();
      const proxyFailure = !!session && !session.submitted && (session.relay.networkFailed() || /ERR_PROXY_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/.test(error.message || ''));
      return { status: STATUS.TEMP, reason: proxyFailure ? 'La proxy no responde antes de enviar las credenciales.' : 'Navegación interrumpida, timeout o conexión temporalmente no disponible.', proxyFailure, beforeSubmit: !session?.submitted };
    }
  }
  cancelResult() { return { status: STATUS.TEMP, reason: 'Procesamiento detenido por el operador. Revisá la sesión antes de reintentar.' }; }
  async openManual(account, proxy) {
    const session = await this.open(account, proxy);
    if (session.page.url() === 'about:blank') await session.page.goto(this.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    return session;
  }
  async checkManual(account) {
    const session = this.sessions.get(account.id);
    if (!session) return { status: STATUS.MANUAL, reason: 'Abrí la sesión y completá la validación manual.' };
    // The operator explicitly requests a fresh observation after resolving the challenge.
    session.security = false; session.securityCode = 0; session.mainStatus = 0;
    try { return await this.observe(session, account) || { status: STATUS.MANUAL, reason: 'Todavía no se pudo confirmar el panel de la tienda. Completá la intervención manual.' }; }
    catch { return { status: STATUS.TEMP, reason: 'La ventana de sesión se cerró o no responde.' }; }
  }
  async close(id) { const session = this.sessions.get(id); if (session) await session.context.close().catch(() => {}); }
  async closeAll() { await Promise.all([...this.sessions.keys()].map(id => this.close(id))); }
}
module.exports = { BrowserService, classifyObservation, bridge, trustedHost };
