# Verificación de entrega

Fecha: 6 de octubre de 2026. Versión: 1.3.0. Plataforma: Windows x64.

## Pruebas completadas

- **24 pruebas automatizadas** de importación TXT/CSV, conservación de contraseñas con separadores, informes sin credenciales, conflictos de contraseñas, clasificación, cola, reintentos, identificación del dominio autenticado, migración de estado y logs, cifrado y exportación: todas correctas.
- **TXT real proporcionado**: 579 registros; 461 cuentas reconocidas, 47 registros duplicados y 71 filas inválidas o no compatibles. Entre las 461 cuentas, 32 tienen contraseñas distintas para la misma identidad y quedan **REQUIERE_DATOS**. La importación fue probada por la interfaz e IPC de Electron; no se enviaron credenciales a Tiendanube.
- **Electron real en desarrollo**: arranque y cierre, interfaz sin errores JavaScript, importaciones mediante IPC real, filtros, pestañas, proxy no disponible y exportación.
- **Ejecutable empaquetado real** `dist/win-unpacked/TiendanubeManager.exe`: mismas verificaciones completas en Windows.
- **Importación CSV real mediante IPC**: el selector acepta `.csv`, interpreta las columnas del proveedor, conserva las credenciales cifradas y muestra endpoints sin autenticación. Las proxies se comprueban en la aplicación, sin confiar en la columna `Status` del archivo.
- **Las cinco proxies suministradas, comprobadas el 5 de octubre**: consulta real a `https://api.ipify.org?format=json` por Chromium y proxy HTTP autenticada; las cinco devolvieron una IP pública válida. Latencia de la consulta en esta prueba: entre 4,3 y 5,4 segundos. La disponibilidad corresponde al momento de la comprobación.
- **Windows safeStorage real**: cifrado y descifrado del estado; credenciales ausentes en los datos enviados a la interfaz y en resultados.
- **Chromium incluido en el paquete**: arranque, tráfico por proxy HTTP local autenticada y consulta de IP simulada, sin depender de un navegador instalado en el equipo.
- **Perfiles persistentes reales**: cookies conservadas al cerrar y reabrir; cookies, localStorage y sessionStorage aislados entre dos perfiles.
- **Login en páginas de prueba controladas** con Chromium visible: acceso válido, contraseña incorrecta, OTP, HTTP 403 y HTTP 429. Máximo un envío de credenciales; ninguno ante OTP o 403 previo al envío.
- **Revisión visual** de capturas del dashboard, tabla de cuentas y proxies.

Evidencia reproducible:

- `test-output/development-smoke.json`
- `test-output/packaged-smoke.json`
- `test-output/supplied-proxy-check.json`
- `test-output/account-format-report.json`
- `test-output/development-format-import.json`
- `test-output/packaged-format-import.json`
- `test-output/dashboard-empty.png`
- `test-output/dashboard-imported.png`
- `test-output/proxies.png`

## Alcance y límites

Se proporcionaron cinco proxies reales y se comprobó su conectividad. El TXT de cuentas recibido se analizó e importó localmente. Se reconoce el formato `URL:email:contraseña` y se informan las filas incompatibles y los conflictos. Las URLs de login general dejan la tienda por identificar hasta confirmar un panel autenticado de Tiendanube. No se iniciaron sesiones reales en Tiendanube. Las pruebas de envío de credenciales se hicieron exclusivamente con datos ficticios y páginas interceptadas localmente.

Las pruebas de integración utilizan una proxy HTTP autenticada local y las cinco proxies HTTP proporcionadas. El soporte HTTPS/SOCKS5 está implementado mediante `proxy-chain`; no se proporcionaron servidores de esos dos protocolos para comprobarlos en red. No se desactiva la validación de certificados para proxies HTTPS.

Los resultados válidos requieren señales de navegación autenticada en el panel de la tienda indicada. Pantallas nuevas o resultados ambiguos se derivan a revisión manual. El instalador no está firmado con un certificado comercial.

El instalador NSIS fue probado con instalación y desinstalación de la versión 1.0.0. Para la versión 1.3.0 se recompiló el instalador y se probó nuevamente el ejecutable empaquetado en Windows. El SHA-256 actualizado se guarda junto al instalador en `dist/TiendanubeManager.sha256`.
