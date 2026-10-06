'use strict';
const { _electron: electron } = require('playwright');
const { Server } = require('proxy-chain');
const { parseProxies } = require('../src/core/model');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { BrowserService } = require('../src/core/browser');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-output');

async function main() {
  await fs.mkdir(output, { recursive: true });
  const userData = await fs.mkdtemp(path.join(output, 'smoke-'));
  const report = { timestamp: new Date().toISOString(), platform: process.platform, executable: process.env.TM_SMOKE_EXE || 'development', checks: [] };
  let app, upstream, browser;
  const errors = [];
  try {
    const launchEnv = { ...process.env, TM_SMOKE_DATA: userData };
    delete launchEnv.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ ...(process.env.TM_SMOKE_EXE ? { executablePath: process.env.TM_SMOKE_EXE, args: [] } : { args: [root] }), env: launchEnv, timeout: 30000 });
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('#stat-total');
    await page.waitForFunction(() => document.getElementById('run-message').textContent.includes('Importá'));
    assert.equal(await page.title(), 'Tiendanube Account Manager');
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false);
    report.checks.push('Windows executable opens; renderer sandbox and context isolation enabled');
    await page.screenshot({ path: path.join(output, 'dashboard-empty.png'), fullPage: true });
    const accountsPath = path.join(userData, 'fixture-accounts.txt');
    await fs.writeFile(accountsPath, 'operator@example.test|DO-NOT-EXPOSE|store.mitiendanube.com\nsecond@example.test|ALSO-SECRET|other.mitiendanube.com');
    // Replace only the native file dialog in the test process, then exercise the
    // normal preload/IPC import path. The production build contains no test IPC.
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, accountsPath);
    assert.equal((await page.evaluate(() => window.manager.invoke('import-accounts'))).ok, true);
    await page.waitForFunction(() => document.getElementById('stat-total').textContent === '2');
    const proxiesPath = path.join(userData, 'fixture-proxies.csv');
    await fs.writeFile(proxiesPath, 'IP,Address:Port:Username:Password,Country-State(Province)-City,Network_Protocol,Status\r\n,127.0.0.1:1:proxy-user:PROXY-SECRET,Test,HTTP,Active');
    let observedFilters;
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async (_window, options) => { globalThis.fixtureFilters = options.filters; return { canceled: false, filePaths: [file] }; }; }, proxiesPath);
    assert.equal((await page.evaluate(() => window.manager.invoke('import-proxies'))).ok, true);
    observedFilters = await app.evaluate(() => globalThis.fixtureFilters);
    assert.ok(observedFilters[0].extensions.includes('csv'));
    const dto = await page.evaluate(() => window.manager.invoke('snapshot'));
    for (const secret of ['DO-NOT-EXPOSE', 'ALSO-SECRET', 'PROXY-SECRET', 'proxy-user']) assert.ok(!JSON.stringify(dto).includes(secret));
    await page.getByLabel('Buscar', { exact: true }).fill('second');
    assert.equal(await page.locator('#table-body tr').count(), 1);
    await page.getByLabel('Buscar', { exact: true }).fill('');
    await page.screenshot({ path: path.join(output, 'dashboard-imported.png'), fullPage: true });
    assert.equal(await page.locator('#start').isEnabled(), false);
    assert.equal(dto.value.proxies.length, 1);
    await page.locator('#proxies-tab').click();
    await page.locator('#check-proxies').click();
    await page.waitForFunction(() => document.getElementById('stat-failed-proxies').textContent === '1');
    await page.screenshot({ path: path.join(output, 'proxies.png'), fullPage: true });
    report.checks.push('Real IPC CSV import, secret-free DTO, search, proxy table and failed connectivity check');
    const encrypted = await fs.readFile(path.join(userData, 'TiendanubeManager/state.bin'));
    assert.ok(!encrypted.includes(Buffer.from('DO-NOT-EXPOSE')));
    const decrypted = await app.evaluate(({ safeStorage }, bytes) => JSON.parse(safeStorage.decryptString(Buffer.from(bytes))), [...encrypted]);
    assert.equal(decrypted.accounts[0].password, 'DO-NOT-EXPOSE');
    const exportPath = path.join(userData, 'export'); await fs.mkdir(exportPath);
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, exportPath);
    const exported = await page.evaluate(() => window.manager.invoke('export')); assert.equal(exported.ok, true);
    await fs.access(path.join(exported.value, 'resultados/validas/accounts.txt'));
    report.checks.push('Windows safeStorage encrypt/decrypt and results export');
    const browserRoot = process.env.TM_SMOKE_EXE ? path.join(path.dirname(process.env.TM_SMOKE_EXE), 'resources/browsers') : path.join(root, 'browsers');
    const chromiumDirectory = (await fs.readdir(browserRoot)).find(name => /^chromium-\d+$/.test(name));
    const executablePath = path.join(browserRoot, chromiumDirectory, 'chrome-win64/chrome.exe');
    await fs.access(executablePath);
    assert.equal(errors.length, 0, errors.join('\n'));
    await app.close(); app = null;
    report.checks.push('Clean application shutdown without renderer errors');

    let proxyHits = 0;
    upstream = new Server({ host: '127.0.0.1', port: 0, prepareRequestFunction: ({ username, password, isHttp }) => {
      if (username !== 'fixture-user' || password !== 'fixture-pass' || !isHttp) return { requestAuthentication: true };
      proxyHits++;
      return { customResponseFunction: () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"ip":"203.0.113.17"}' }) };
    } });
    await upstream.listen();
    const proxy = parseProxies('http://fixture-user:fixture-pass@127.0.0.1:' + upstream.port)[0];
    browser = new BrowserService({ executablePath, profilePath: id => path.join(userData, 'profiles', id), ipUrl: 'http://fixture.test/ip', diagnostics: detail => console.log('Browser fixture diagnostic', detail) });
    const probe = await browser.probe(proxy); assert.equal(probe.status, 'DISPONIBLE'); assert.equal(probe.ip, '203.0.113.17'); assert.ok(proxyHits > 0);
    report.checks.push('Bundled Chromium, authenticated HTTP proxy forwarding, IP and latency probing');
    const account1 = { id: 'account_001', store_url: 'store.mitiendanube.com' }, account2 = { id: 'account_002', store_url: 'other.mitiendanube.com' };
    const first = await browser.open(account1, proxy);
    await first.context.route('https://store.mitiendanube.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<a href="/admin/products">Productos</a><h1>Mi tienda</h1>' }));
    await first.context.addCookies([{ name: 'fixture', value: 'private-account-one', domain: 'store.mitiendanube.com', path: '/', expires: Date.now() / 1000 + 3600, secure: true }]);
    await first.page.goto('https://store.mitiendanube.com/admin/');
    await first.page.evaluate(() => { localStorage.setItem('private', 'account-one'); sessionStorage.setItem('private', 'account-one'); });
    assert.equal((await browser.observe(first, account1)).status, 'VALIDA');
    const second = await browser.open(account2, proxy);
    assert.equal((await second.context.cookies()).length, 0);
    await second.context.route('https://store.mitiendanube.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Separate profile</h1>' }));
    await second.page.goto('https://store.mitiendanube.com/');
    assert.deepEqual(await second.page.evaluate(() => [localStorage.getItem('private'), sessionStorage.getItem('private')]), [null, null]);
    await browser.close(account1.id);
    const reopened = await browser.open(account1, proxy);
    assert.ok((await reopened.context.cookies()).some(c => c.name === 'fixture' && c.value === 'private-account-one'));
    report.checks.push('Persistent cookies survive reopen; cookies/localStorage/sessionStorage isolated by profile');
    await browser.closeAll();
    const originalOpen = browser.open.bind(browser);
    let scenario = 'success', submissions = 0;
    browser.open = async (account, p) => {
      const session = await originalOpen(account, p);
      await session.context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname === 'www.tiendanube.com' && url.pathname === '/session') {
          submissions++;
          assert.deepEqual(JSON.parse(route.request().postData()), { email: 'fixture@example.test', password: 'fictional-password' });
          await route.fulfill({ status: scenario === '429' ? 429 : 200, contentType: 'application/json', body: '{}' }); return;
        }
        if (url.pathname.startsWith('/admin')) { await route.fulfill({ contentType: 'text/html', body: '<h1>Panel</h1><a href="/admin/orders">Ventas</a>' }); return; }
        if (scenario === '403') { await route.fulfill({ status: 403, contentType: 'text/html', body: '<h1>Acceso restringido</h1>' }); return; }
        if (scenario === 'otp') { await route.fulfill({ contentType: 'text/html', body: '<h1>Ingresá el código enviado al correo</h1><input autocomplete="one-time-code">' }); return; }
        const afterSubmit = scenario === 'invalid' ? "document.body.innerHTML='<h1>Contraseña incorrecta</h1>'" : scenario === '429' ? "document.body.innerHTML='<h1>Esperá</h1>'" : "location.href='https://store.mitiendanube.com/admin/'";
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<input type="email"><input type="password"><button type="button" id="login-submit-btn">Ingresar</button><script>document.querySelector('button').onclick=async()=>{await fetch('/session',{method:'POST',body:JSON.stringify({email:document.querySelector('[type=email]').value,password:document.querySelector('[type=password]').value})});${afterSubmit}}</script>` });
      });
      return session;
    };
    for (const [index, entry] of [['success', 'VALIDA'], ['invalid', 'NO_FUNCIONA'], ['otp', 'REQUIERE_VALIDACION'], ['403', 'REQUIERE_VALIDACION'], ['429', 'REQUIERE_VALIDACION']].entries()) {
      [scenario] = entry; submissions = 0;
      console.log(`Testing browser fixture: ${scenario}`);
      const account = { id: `account_${index + 10}`, email: 'fixture@example.test', password: 'fictional-password', store_url: scenario === 'success' ? '' : 'store.mitiendanube.com' };
      const result = await browser.login(account, proxy, new AbortController().signal, () => {});
      assert.equal(result.status, entry[1], `${scenario}: ${result.reason}`);
      if (scenario === 'success') assert.equal(result.store_url, 'store.mitiendanube.com');
      assert.equal(submissions, ['otp', '403'].includes(scenario) ? 0 : 1);
      await browser.close(account.id);
    }
    report.checks.push('Visible Chromium login fixtures: success, incorrect credentials, OTP, HTTP 403, HTTP 429; at most one submission');
    assert.equal(errors.length, 0);
    report.passed = true;
    await fs.writeFile(path.join(output, process.env.TM_SMOKE_EXE ? 'packaged-smoke.json' : 'development-smoke.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser?.closeAll(); await upstream?.close(true); await app?.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
