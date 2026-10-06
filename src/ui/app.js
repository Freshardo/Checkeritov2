'use strict';
const $ = id => document.getElementById(id);
let state = { accounts: [], proxies: [], mode: 'IDLE', message: '' }, view = 'accounts', page = 1, selected = new Set(), toastTimer;
const pageSize = 25;
const labels = { PENDIENTE: 'Pendiente', PROCESANDO: 'Procesando', VALIDA: 'Válida', REQUIERE_VALIDACION: 'Requiere validación', REQUIERE_DATOS: 'Revisar datos', NO_FUNCIONA: 'No funciona', ERROR_TEMPORAL: 'Error temporal', DISPONIBLE: 'Disponible', SIN_COMPROBAR: 'Sin comprobar' };
const busy = () => ['RUNNING', 'CHECKING', 'PAUSING', 'STOPPING'].includes(state.mode);
function toast(message, error = false) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').className = error ? 'error' : ''; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, error ? 10000 : 5000); }
async function invoke(command, arg) {
  try { const response = await window.manager.invoke(command, arg); if (!response.ok) throw new Error(response.error); if (command === 'export' && response.value) toast(`Resultados exportados en ${response.value}`); if (command === 'import-accounts' && response.value) showImportReport(response.value); return response.value; }
  catch (e) { toast(e.message || 'No se pudo completar la operación.', true); return null; }
}
function element(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function badge(status) { return element('span', labels[status] || status, `badge ${Object.hasOwn(labels, status) ? status : 'neutral'}`); }
function time(iso) { return iso ? new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '—'; }
function showImportReport(report) {
  $('import-summary').textContent = `${report.totalRecords} registros leídos · ${report.importedRecords} cuentas reconocidas · ${report.duplicates} duplicados · ${report.invalidRecords} filas omitidas · ${report.conflicts} cuentas con contraseñas distintas.`;
  const rows = report.issues.map(issue => { const tr = element('tr'); tr.append(element('td', issue.line), element('td', issue.reason, 'reason')); return tr; });
  $('import-issues').replaceChildren(...rows);
  $('import-issues-table').hidden = !rows.length;
  $('review-data').hidden = !report.conflicts;
  $('import-report').showModal();
}
function changeView(next) {
  view = next; page = 1; $('search').value = ''; $('status-filter').replaceChildren(element('option', 'Todos los estados')); $('status-filter').firstChild.value = '';
  const statuses = next === 'accounts' ? ['PENDIENTE', 'PROCESANDO', 'VALIDA', 'REQUIERE_VALIDACION', 'REQUIERE_DATOS', 'NO_FUNCIONA', 'ERROR_TEMPORAL'] : ['SIN_COMPROBAR', 'DISPONIBLE', 'NO_FUNCIONA'];
  for (const status of statuses) { const option = element('option', labels[status]); option.value = status; $('status-filter').append(option); }
  document.querySelectorAll('[data-view]').forEach(el => { const active = el.dataset.view === next; el.classList.toggle('active', active); if (el.getAttribute('role') === 'tab') el.setAttribute('aria-selected', String(active)); });
  $('breadcrumb-view').textContent = next === 'accounts' ? 'Resumen' : 'Proxies'; $('search').placeholder = next === 'accounts' ? 'Buscar cuenta o tienda…' : 'Buscar proxy o IP…'; render();
}
function render() {
  const counts = {};
  for (const a of state.accounts) counts[a.status] = (counts[a.status] || 0) + 1;
  const processed = ['VALIDA', 'REQUIERE_VALIDACION', 'NO_FUNCIONA', 'ERROR_TEMPORAL'].reduce((total, status) => total + (counts[status] || 0), 0);
  const percent = state.accounts.length ? Math.round(processed / state.accounts.length * 100) : 0;
  const values = { total: state.accounts.length, processed, valid: counts.VALIDA || 0, manual: counts.REQUIERE_VALIDACION || 0, invalid: counts.NO_FUNCIONA || 0, temp: counts.ERROR_TEMPORAL || 0, proxies: state.proxies.filter(p => p.status === 'DISPONIBLE').length, 'failed-proxies': state.proxies.filter(p => p.status === 'NO_FUNCIONA').length };
  for (const [key, value] of Object.entries(values)) $(`stat-${key}`).textContent = value.toLocaleString('es-AR');
  $('stat-percent').textContent = `${percent}% del total`; $('progress').value = percent;
  $('accounts-count').textContent = state.accounts.length; $('proxies-count').textContent = state.proxies.length; $('nav-proxies').textContent = state.proxies.length;
  const modeLabels = { IDLE: 'En espera', RUNNING: 'En proceso', PAUSED: 'Pausado', PAUSING: 'Pausando', STOPPING: 'Deteniendo', CHECKING: 'Comprobando' };
  $('mode-badge').textContent = modeLabels[state.mode]; $('run-title').textContent = state.mode === 'IDLE' ? 'Listo para comenzar' : state.mode === 'PAUSED' ? 'Procesamiento pausado' : 'Gestionando tus conexiones';
  $('run-message').textContent = state.message;
  const current = state.accounts.find(a => a.id === state.currentId);
  $('current-proxy').textContent = `Proxy: ${current?.proxy || '—'}`; $('current-ip').textContent = `IP de salida: ${current?.ip || '—'}`;
  $('start').hidden = state.mode === 'PAUSED'; $('resume').hidden = state.mode !== 'PAUSED';
  $('start').disabled = busy() || !(counts.PENDIENTE > 0) || !values.proxies; $('resume').disabled = busy() || !state.canResume || !values.proxies;
  $('pause').disabled = state.mode !== 'RUNNING'; $('stop').disabled = !busy() && state.mode !== 'PAUSED';
  for (const el of document.querySelectorAll('[data-command="import-accounts"], [data-command="import-proxies"], [data-command="check-proxies"]')) el.disabled = busy() || el.dataset.command === 'check-proxies' && !state.proxies.length;
  renderTable();
}
function renderTable() {
  const query = $('search').value.toLowerCase(); const filter = $('status-filter').value;
  const source = state[view].filter(item => (!filter || item.status === filter) && (view === 'accounts' ? `${item.email} ${item.store_url} ${item.reason}` : `${item.label} ${item.ip}`).toLowerCase().includes(query));
  const pages = Math.max(1, Math.ceil(source.length / pageSize)); page = Math.min(page, pages);
  const items = source.slice((page - 1) * pageSize, page * pageSize);
  const head = element('tr');
  const headings = view === 'accounts' ? ['', 'Cuenta', 'Tienda', 'Proxy / IP de salida', 'Estado', 'Motivo', 'Hora', 'Acción'] : ['Proxy', 'IP de salida', 'Tipo', 'Latencia', 'Estado', 'Comprobada'];
  for (const title of headings) head.append(element('th', title));
  if (view === 'accounts') {
    const all = element('input'); all.type = 'checkbox'; all.setAttribute('aria-label', 'Seleccionar cuentas de esta página'); all.checked = !!items.length && items.every(a => selected.has(a.id));
    all.addEventListener('change', () => { for (const a of items) all.checked ? selected.add(a.id) : selected.delete(a.id); renderTable(); }); head.firstChild.append(all);
  }
  $('table-head').replaceChildren(head); const rows = [];
  for (const item of items) {
    const tr = element('tr');
    if (view === 'accounts') {
      const selectCell = element('td'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(item.id); checkbox.setAttribute('aria-label', `Seleccionar ${item.email}`); checkbox.addEventListener('change', () => { checkbox.checked ? selected.add(item.id) : selected.delete(item.id); renderTable(); }); selectCell.append(checkbox);
      const email = element('td', item.email, 'email'); email.title = item.email; email.append(element('small', `${item.id}${item.sourceLine ? ` · Línea ${item.sourceLine}` : ''}`));
      const store = element('td', item.store_url || 'Por identificar'); store.title = item.store_url || 'La tienda se identifica al confirmar el panel autenticado.';
      const proxy = element('td', item.proxy || '—'); proxy.title = item.proxy; proxy.append(element('small', item.ip || 'IP sin comprobar'));
      const status = element('td'); status.append(badge(item.status));
      const actions = element('td'); const group = element('div', undefined, 'row-actions');
      const addAction = (label, command, disabled) => { const button = element('button', label, 'text-button'); button.disabled = busy() || disabled; button.addEventListener('click', () => invoke(command, item.id)); group.append(button); };
      addAction('Abrir sesión', 'open-session', !item.proxy || item.credentialConflict);
      if (item.status !== 'PENDIENTE') addAction('Verificar sesión', 'check-session', !item.proxy);
      if (item.status === 'ERROR_TEMPORAL' && !item.securityLocked) addAction('Cambiar proxy', 'change-proxy', false);
      actions.append(group); tr.append(selectCell, email, store, proxy, status, element('td', item.reason || '—', 'reason'), element('td', time(item.timestamp)), actions);
    } else {
      const status = element('td'); status.append(badge(item.status));
      tr.append(element('td', item.label, 'email'), element('td', item.ip || '—'), element('td', item.type.toUpperCase()), element('td', item.latency === null ? '—' : `${item.latency} ms`), status, element('td', time(item.checkedAt)));
    }
    rows.push(tr);
  }
  $('table-body').replaceChildren(...rows); $('empty-state').hidden = !!source.length;
  if (!source.length) {
    const empty = $('empty-state'); const hasData = state[view].length > 0;
    empty.querySelector('h2').textContent = hasData ? 'No hay coincidencias' : view === 'accounts' ? 'Tu próxima sesión empieza acá' : 'Conectá tus proxies';
    empty.querySelector('p').textContent = hasData ? 'Probá otra búsqueda o cambiá el filtro de estado.' : view === 'accounts' ? 'Importá un archivo de cuentas para organizar tus tiendas y comenzar a gestionar sus accesos.' : 'Importá tus proxies y comprobá su IP de salida antes de iniciar.';
    const button = empty.querySelector('button'); button.hidden = hasData; button.dataset.command = view === 'accounts' ? 'import-accounts' : 'import-proxies'; button.textContent = view === 'accounts' ? 'Importar accounts.txt ↗' : 'Importar proxies.txt ↗';
    empty.querySelector('small').textContent = hasData ? '' : view === 'accounts' ? 'Formatos: URL:email:contraseña o email|contraseña|tienda' : 'HTTP · HTTPS · SOCKS5 · Autenticación compatible';
  }
  $('table-summary').textContent = `${source.length ? (page - 1) * pageSize + 1 : 0}–${Math.min(page * pageSize, source.length)} de ${source.length} ${view === 'accounts' ? 'cuentas' : 'proxies'}`;
  $('page-label').textContent = `Página ${page} de ${pages}`; $('prev-page').disabled = page === 1; $('next-page').disabled = page === pages;
  $('selection-bar').hidden = !selected.size || view !== 'accounts'; $('selected-count').textContent = `${selected.size} seleccionadas`;
  const eligible = state.accounts.filter(a => selected.has(a.id)); $('retry').disabled = busy() || eligible.some(a => a.securityLocked || !['PENDIENTE', 'ERROR_TEMPORAL', 'NO_FUNCIONA'].includes(a.status));
}
document.addEventListener('click', event => { const command = event.target.closest('[data-command]'); if (command && !command.disabled) invoke(command.dataset.command); const viewButton = event.target.closest('[data-view]'); if (viewButton) changeView(viewButton.dataset.view); });
$('search').addEventListener('input', () => { page = 1; renderTable(); }); $('status-filter').addEventListener('change', () => { page = 1; renderTable(); });
$('prev-page').addEventListener('click', () => { page--; renderTable(); }); $('next-page').addEventListener('click', () => { page++; renderTable(); });
$('clear-selection').addEventListener('click', () => { selected.clear(); renderTable(); }); $('retry').addEventListener('click', () => invoke('retry', [...selected]));
$('close-import-report').addEventListener('click', () => $('import-report').close());
$('review-data').addEventListener('click', () => { $('import-report').close(); changeView('accounts'); $('status-filter').value = 'REQUIERE_DATOS'; renderTable(); });
window.manager.subscribe(next => { state = next; render(); });
invoke('snapshot').then(next => { if (next) state = next; changeView('accounts'); });
