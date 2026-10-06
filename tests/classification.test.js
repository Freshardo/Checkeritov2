'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyObservation } = require('../src/core/browser');
const account = { store_url: 'store.mitiendanube.com' };
test('403, 429, OTP, 2FA and CAPTCHA require manual validation ahead of all other classifications', () => {
  for (const observation of [{ status: 403 }, { status: 429 }, { challenge: true }, { text: 'Te enviamos un código por correo' }, { text: 'Autenticación de dos factores' }, { text: 'CAPTCHA: contraseña incorrecta' }]) assert.equal(classifyObservation(observation, account).status, 'REQUIERE_VALIDACION');
});
test('invalid credentials and transient server errors stay distinct', () => {
  assert.equal(classifyObservation({ text: 'Contraseña incorrecta' }, account).status, 'NO_FUNCIONA');
  assert.equal(classifyObservation({ status: 503 }, account).status, 'ERROR_TEMPORAL');
});
test('only authenticated admin of requested store qualifies as valid', () => {
  const observation = { url: 'https://store.mitiendanube.com/admin/', dashboard: true };
  assert.equal(classifyObservation(observation, account).status, 'VALIDA');
  for (const changes of [{ dashboard: false }, { passwordVisible: true }, { url: 'https://another.mitiendanube.com/admin/' }, { url: 'https://store.mitiendanube.com/admin/login' }, { url: 'http://store.mitiendanube.com/admin/' }]) assert.equal(classifyObservation({ ...observation, ...changes }, account), null);
});
test('an unspecified store can be discovered only on a trusted authenticated admin panel', () => {
  const generic = { store_url: '' };
  const observation = { url: 'https://store.mitiendanube.com/admin/', dashboard: true };
  const result = classifyObservation(observation, generic); assert.equal(result.status, 'VALIDA'); assert.equal(result.store_url, 'store.mitiendanube.com');
  for (const changes of [{ dashboard: false }, { passwordVisible: true }, { url: 'https://evil.test/admin/' }, { url: 'https://www.tiendanube.com/login' }]) assert.equal(classifyObservation({ ...observation, ...changes }, generic), null);
});
