# BlackLabs QZ Tray Engine

Motor genérico de impresión ESC/POS vía [QZ Tray](https://qz.io) para Odoo 18 CE.

Resuelve un problema concreto: **un mismo TPV se opera desde varias PCs, cada una con su
impresora, y dos PCs distintas pueden tener impresoras con el mismo nombre.** Por eso la
impresora no es propiedad del TPV sino **del equipo**.

Los módulos que imprimen no hablan con QZ Tray: le piden al motor que resuelva qué impresora
corresponde y le entregan el payload ESC/POS.

---

## Concepto

Cada navegador guarda un UUID en `localStorage` (`bl_qz_device_uuid`) que lo identifica como
equipo. Ese UUID resuelve un registro `bl.qz.device` con:

- `qz_enabled` — si está en `false`, el módulo debe imprimir de forma nativa.
- `printer_mode` — `global` (una impresora para todo) o `per_module` (una por módulo).
- `printer_name` — la impresora general del equipo.
- `printer_ids` — filas por módulo (`fiscal`, `retiro`, `comanda`, `mozo`, …).

El dispositivo queda disponible en el POS como `this.pos.bl_qz_device` y también como
`this.pos.config.bl_qz_device`.

**El equipo no pertenece a ninguna compañía.** Una PC es una PC: el mismo registro se ve y se
edita desde todas las compañías. Por eso una máquina que opera varias sigue siendo un solo equipo.

La configuración se hace desde el backend, en la sección **Impresora ESC/POS QZ Tray**,
para el grupo `point_of_sale.group_pos_manager`.

---

## Qué impresora se usa

Gana la primera que resuelva:

1. La fila del módulo, si el equipo está en modo `per_module`
2. `printer_name` del equipo
3. `bl_qz_fallback_printer_name` del TPV
4. La predeterminada del sistema en esa PC

Dejar vacío el respaldo del TPV es la opción dinámica: cada PC imprime en su predeterminada sin
configurar ningún nombre. Cargarlo fija el destino.

---

## Integrar un módulo nuevo

### 1. Declarar la dependencia

```python
# __manifest__.py
"depends": ["point_of_sale", "bl_qz_tray_engine"],
```

### 2. Registrar la clave del módulo

Dos herencias. La primera agrega la opción a la lista; la segunda hace que Odoo cree la fila
automáticamente en cada equipo.

```python
# models/bl_qz_device_printer.py
from odoo import api, models


class BlQzDevicePrinter(models.Model):
    _inherit = "bl.qz.device.printer"

    @api.model
    def _bl_qz_module_keys(self):
        return super()._bl_qz_module_keys() + [
            ("etiqueta", "Etiquetas de despacho"),
        ]


class BlQzDevice(models.Model):
    _inherit = "bl.qz.device"

    @api.model
    def _bl_qz_default_module_rows(self):
        return super()._bl_qz_default_module_rows() + [("etiqueta", 50)]
```

El segundo valor de la tupla es la secuencia: define el orden en el panel.

### 3. Imprimir desde el JS

```js
/** @odoo-module **/

import {
    resolvePrinterConfigFor,
    sendRawToQzPrinter,
    getFriendlyQzTrayErrorMessage,
} from "@bl_qz_tray_engine/js/bl_qz_engine";

const MODULE_KEY = "etiqueta";

async function printLabel(posConfig, escPosPayload) {
    const resolved = await resolvePrinterConfigFor(
        posConfig.bl_qz_device || null,
        posConfig,
        MODULE_KEY
    );

    // null = este equipo no usa QZ. Hay que imprimir de forma nativa.
    if (!resolved) {
        return null;
    }

    await sendRawToQzPrinter(escPosPayload, {
        ...posConfig,
        qz_tray_printer_name: resolved.printer_name,
        qz_ticket_copies: resolved.copies,
        qz_tray_force_raw: resolved.force_raw,
    }, {
        jobName: "POS Etiqueta",
        copies: resolved.copies,
        forceRaw: false,
    });

    return true;
}
```

**Los tres resultados posibles hay que tratarlos por separado:**

| Resultado | Significado | Qué hacer |
|---|---|---|
| `null` | QZ deshabilitado en este equipo | imprimir nativo, **avisando al usuario** |
| `true` | impreso | nada |
| excepción | QZ caído, sin impresora, error de conexión | avisar con `getFriendlyQzTrayErrorMessage` y usar respaldo |

Nunca dejes un camino de impresión que falle en silencio.

---

## Ejemplo 1 — ticket de texto plano

```js
const ESC = "\x1B";
const GS = "\x1D";

function buildPayload(text) {
    const init = `${ESC}@`;          // reset
    const alignLeft = `${ESC}a\x00`; // 0 izq, 1 centro, 2 der
    const cut = `${GS}V\x41\x00`;    // corte parcial
    return `${init}${alignLeft}${text}\n${cut}`;
}

await sendRawToQzPrinter(buildPayload("Hola mundo"), posConfig, {
    jobName: "Prueba",
});
```

## Ejemplo 2 — ticket con logo

Para mezclar imágenes con texto, el payload es un **array**. Las cadenas son ESC/POS y los
objetos son imágenes.

```js
import {
    prepareLogoForEscPos,
    buildQzEscPosImageObject,
    getEscPosImageDotDensity,
    getEscPosImageEncoding,
} from "@bl_qz_tray_engine/js/bl_qz_logo";

const logoBlock = await prepareLogoForEscPos(receiptData, posConfig, this.orm);
const logoObject = buildQzEscPosImageObject(logoBlock, {
    dotDensity: getEscPosImageDotDensity(posConfig),
    imageEncoding: getEscPosImageEncoding(posConfig),
});

const payload = [];
if (logoObject) {
    payload.push(`${ESC}@${ESC}a\x01`);  // init + centrado
    payload.push(logoObject);
    payload.push("\x0A");
}
payload.push(buildPayload(cuerpoDelTicket));

await sendRawToQzPrinter(payload, posConfig, { jobName: "Ticket" });
```

> **Nunca conviertas el array a string.** `String(payload)` serializa los objetos de imagen
> como `[object Object]` y el logo sale impreso como ese texto literal. El motor ya acepta
> arrays: pasalo tal cual.

## Ejemplo 3 — respaldo cuando no hay QZ

```js
let printed = false;
let qzDisabled = false;

try {
    const result = await printLabel(posConfig, payload);
    if (result === null) {
        qzDisabled = true;
    } else {
        printed = Boolean(result);
    }
} catch (error) {
    this.notification.add(
        getFriendlyQzTrayErrorMessage(error, "No se pudo imprimir por QZ Tray."),
        { type: "warning" }
    );
}

if (!printed) {
    this.notification.add(
        qzDisabled
            ? _t("Este equipo no tiene impresora QZ configurada.")
            : _t("QZ Tray no estuvo disponible. Se usa impresión directa."),
        { type: "warning" }
    );
    await this._printFallback(payload);
}
```

---

## API

Desde `@bl_qz_tray_engine/js/bl_qz_engine`:

| Función | Devuelve |
|---|---|
| `resolvePrinterConfigFor(device, posConfig, moduleKey)` | `{printer_name, copies, force_raw}` o `null` |
| `sendRawToQzPrinter(payload, posConfig, options)` | `true`, o lanza excepción |
| `sendPixelHtmlToQzPrinter(html, posConfig, options)` | impresión por píxeles, no ESC/POS |
| `sendPixelPdfToQzPrinter(pdfBase64, posConfig, options)` | idem, para PDF |
| `isEscPosQzEnabled(posConfig)` | `boolean` |
| `listQzTrayPrinters()` | array de nombres |
| `warmUpQzConnection(posConfig)` | precalienta el socket, útil al abrir sesión |
| `clearQzPrinterCache()` | invalida la caché de impresoras |
| `getFriendlyQzTrayErrorMessage(error, fallback)` | mensaje legible |
| `blQzGetDeviceUuid()` | UUID del equipo |

`options` de `sendRawToQzPrinter`:

- `jobName` — nombre del trabajo en la cola. Por defecto `"POS ESC/POS"`.
- `copies` — 1 a 10. Si se omite, toma el valor de la configuración.
- `forceRaw` — **en Windows se ignora**: QZ registra `Forced raw printing is not supported on
  Windows` y el trabajo sale igual por el spooler. Dejarlo en `false`.
- `applyGlobalCenterAlignment` — `false` si ya controlás la alineación en el payload.

Desde `@bl_qz_tray_engine/js/bl_qz_logo`: `prepareLogoForEscPos`, `normalizeLogoForEscPos`,
`buildQzEscPosImageObject`, `getEscPosImageDotDensity`, `getEscPosImageEncoding`,
`buildArcaAuthorizationRasterBase64`, `clearBlQzRasterCaches`.

---

## Errores frecuentes

**El logo sale como `[object Object]`.** Alguien convirtió el array a string en el camino.

**Imprime en la impresora equivocada.** El equipo está en `per_module` y la fila del módulo
tiene otro nombre. Revisá el panel del equipo.

**No imprime y no avisa nada.** `resolvePrinterConfigFor` devolvió `null` y el módulo no
trató ese caso. Ver la tabla de los tres resultados.

**El trabajo sale pero no aparece el papel.** Antes de revisar código, mirá el log de QZ Tray
en la PC (`%APPDATA%\qz\debug.log`). Si dice `Printing complete`, el trabajo llegó a la
impresora y el problema es físico: cable, papel o cola de Windows.

**Hay más equipos de los esperados.** Cada perfil de navegador genera su propio UUID. Los
sobrantes se borran desde el panel.

**No cargues `qz-tray.js` en `web.assets_backend`.** Rompe el cliente web entero: la librería
usa `require('path')`, que no resuelve. El motor la carga bajo demanda con `loadJS()`.

---

## Requisitos

- Odoo 18 CE, `point_of_sale`, `mail`
- Python: `cryptography`
- QZ Tray 2.2.x instalado en cada PC que imprima

Licencia LGPL-3 · Ernesto Bernís — BlackLabs

