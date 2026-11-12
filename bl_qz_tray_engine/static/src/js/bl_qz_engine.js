/** @odoo-module */

import {
    QZ_PRINT_TIMEOUT_MS,
    describeQzConnectionError,
    ensureQzConnection,
    ensureQzSecurityConfigured,
    findQzPrinters,
    getQzDefaultPrinter,
    runQzOperation,
} from "./bl_qz_security";
import { applyQzWorkstationOverrides } from "./bl_qz_settings";

const CONNECT_OPTIONS = {
    retries: 1,
    delay: 0,
};

const READY_CHECK_OPTIONS = {
    attempts: 1,
    delayMs: 0,
};

const ESC = "\x1B";
const ESC_POS_INIT = `${ESC}@`;
const ESC_POS_ALIGN_LEFT = `${ESC}a\x00`;
const ESC_POS_ALIGN_CENTER = `${ESC}a\x01`;
const ESC_POS_ALIGN_RIGHT = `${ESC}a\x02`;

let connectPromise = null;
let cachedPrinterKey = "";
let cachedPrinterName = "";
// La impresora resuelta se recuerda un rato: sin vencimiento, una impresora retirada del
// sistema (o la decision de caer en la predeterminada) quedaba pegada hasta recargar (H5).
const QZ_PRINTER_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedPrinterTs = 0;

const QZ_TRAY_UNAVAILABLE_MESSAGE =
    "QZ Tray parece estar cerrado o no disponible en este equipo. Abri la aplicacion QZ Tray y reintenta la impresion.";
const BL_QZ_DEVICE_UUID_KEY = "bl_qz_device_uuid";

// Si el navegador no deja guardar datos (modo restringido, almacenamiento bloqueado), el
// identificador se recuerda en memoria durante la vida de la pestania: sin esto cada
// llamada devolvia uno nuevo y el servidor creaba un equipo nuevo por cada carga (H9).
let memoryDeviceUuid = "";

export function blQzGetDeviceUuid() {
    let storedUuid = "";
    try {
        storedUuid = (window.localStorage.getItem(BL_QZ_DEVICE_UUID_KEY) || "").trim();
    } catch {
        storedUuid = "";
    }

    if (storedUuid) {
        return storedUuid;
    }
    if (memoryDeviceUuid) {
        return memoryDeviceUuid;
    }

    let generatedUuid = "";
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        generatedUuid = crypto.randomUUID();
    }
    if (!generatedUuid) {
        generatedUuid = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    }

    memoryDeviceUuid = generatedUuid;
    try {
        window.localStorage.setItem(BL_QZ_DEVICE_UUID_KEY, generatedUuid);
    } catch {
        // Ignore storage write failures; the generated uuid is still usable.
    }
    return generatedUuid;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function normalizeQzErrorMessage(error) {
    if (!error) {
        return "";
    }
    if (typeof error === "string") {
        return error.trim();
    }
    // Los errores de la puerta (bl_qz_security.js) traen el mensaje en espanol y
    // el detalle crudo de QZ Tray aparte: la clasificacion usa el crudo.
    if (typeof error.blQzDetail === "string" && error.blQzDetail) {
        return error.blQzDetail.trim();
    }
    if (typeof error.message === "string") {
        return error.message.trim();
    }
    if (typeof error.msg === "string") {
        return error.msg.trim();
    }
    return "";
}

function isLikelyQzTrayUnavailable(errorMessage) {
    const message = String(errorMessage || "").toLowerCase();
    if (!message) {
        return false;
    }
    if (message.includes("already exists")) {
        return false;
    }

    const mentionsQzContext =
        message.includes("qz") ||
        message.includes("websocket") ||
        message.includes("localhost") ||
        message.includes("wss://");
    const mentionsConnectionFailure = [
        "connect",
        "connection",
        "refused",
        "timed out",
        "closed",
        "network",
        "econnrefused",
        "1006",
    ].some((token) => message.includes(token));

    return mentionsQzContext && mentionsConnectionFailure;
}

function buildQzTrayUnavailableMessage(detail = "") {
    const normalizedDetail = String(detail || "").trim();
    return normalizedDetail
        ? `${QZ_TRAY_UNAVAILABLE_MESSAGE}\n${normalizedDetail}`
        : QZ_TRAY_UNAVAILABLE_MESSAGE;
}

function isTransientQzConnectionError(error) {
    const detail = normalizeQzErrorMessage(error).toLowerCase();
    if (!detail) {
        return false;
    }

    return [
        "already exists",
        "current connection attempt has not returned yet",
        "waiting for previous disconnect request to complete",
        "connection closed before response received",
        "a connection to qz has not been established yet",
        "websocket",
        "network",
    ].some((token) => detail.includes(token));
}

// Errores que ocurren ANTES de que QZ Tray reciba el trabajo: reintentar es seguro.
// Los demas (corte "connection closed before response received", websocket, network) pueden
// llegar DESPUES de que la impresora ya recibio el ticket: reintentar solo lo duplica (H4).
function isSafeToRetryPrint(error) {
    const detail = normalizeQzErrorMessage(error).toLowerCase();
    if (!detail) {
        return false;
    }
    return [
        "already exists",
        "current connection attempt has not returned yet",
        "waiting for previous disconnect request to complete",
        "a connection to qz has not been established yet",
    ].some((token) => detail.includes(token));
}

// Quien muestra el aviso "posible falla de comunicacion con la impresora" (el POS lo registra
// con un dialogo). Recibe { jobName, printerName, attempt, error } y devuelve una promesa con
// "retry" (reintentar), "printed" (ya se imprimio) o "cancel".
const MAX_AMBIGUOUS_ATTEMPTS = 3;
let ambiguousPrintHandler = null;

export function blQzSetAmbiguousPrintHandler(handler) {
    ambiguousPrintHandler = typeof handler === "function" ? handler : null;
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQzReady(qz, options = {}) {
    const attempts = Math.max(1, Number.parseInt(options.attempts, 10) || READY_CHECK_OPTIONS.attempts);
    const delayMs = Math.max(0, Number.parseInt(options.delayMs, 10) || READY_CHECK_OPTIONS.delayMs);
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            await qz.api.getVersion();
            return;
        } catch (error) {
            lastError = error;
            const shouldRetry = isTransientQzConnectionError(error) && attempt < attempts - 1;
            if (!shouldRetry) {
                throw error;
            }
            if (delayMs > 0) {
                await wait(delayMs);
            }
        }
    }

    if (lastError) {
        throw lastError;
    }
}

async function reconnectSocket(qz) {
    clearQzPrinterCache();
    // La puerta unica (bl_qz_security.js) reabre y verifica el socket si hace falta.
    await ensureQzConnection();
    return qz;
}

export function getFriendlyQzTrayErrorMessage(error, fallbackMessage = "") {
    return describeQzConnectionError(error, fallbackMessage);
}

function normalizePrinterName(value) {
    return typeof value === "string" ? value.trim() : "";
}

function normalizePrinterList(value) {
    const values = Array.isArray(value) ? value : [value];
    const uniquePrinters = new Set();

    for (const candidate of values) {
        const printerName = normalizePrinterName(candidate);
        if (printerName) {
            uniquePrinters.add(printerName);
        }
    }

    return Array.from(uniquePrinters).sort((left, right) =>
        left.localeCompare(right, undefined, { sensitivity: "base" })
    );
}

function normalizePrinterNameForMatch(value) {
    return normalizePrinterName(value)
        .toLowerCase()
        .replace(/[\s_-]+/g, "");
}

function findClosestPrinterName(configuredName, printers) {
    const target = normalizePrinterNameForMatch(configuredName);
    if (!target || !Array.isArray(printers) || !printers.length) {
        return "";
    }

    for (const printerName of printers) {
        if (normalizePrinterNameForMatch(printerName) === target) {
            return printerName;
        }
    }

    return "";
}

async function ensureConnected(qz) {
    // Conexion, topes, verificacion y reconexion viven en la puerta unica
    // (bl_qz_security.js), compartida con el campo y el panel del backend.
    await ensureQzConnection();
    return qz;
}

export async function listQzTrayPrinters() {
    const result = await findQzPrinters();
    return normalizePrinterList(result);
}

export function clearQzPrinterCache() {
    cachedPrinterKey = "";
    cachedPrinterName = "";
    cachedPrinterTs = 0;
}

async function resolvePrinterName(qz, posConfig) {
    const configuredName = normalizePrinterName(posConfig?.qz_tray_printer_name);
    const cacheKey = configuredName || "__qz_default_printer__";

    if (
        cachedPrinterKey === cacheKey &&
        cachedPrinterName &&
        Date.now() - cachedPrinterTs < QZ_PRINTER_CACHE_TTL_MS
    ) {
        return cachedPrinterName;
    }

    const resolvedPrinterName = await resolvePrinterNameUncached(qz, posConfig);
    if (resolvedPrinterName) {
        cachedPrinterKey = cacheKey;
        cachedPrinterName = resolvedPrinterName;
        cachedPrinterTs = Date.now();
    }
    return resolvedPrinterName;
}

async function resolvePrinterNameUncached(qz, posConfig) {
    const configuredName = normalizePrinterName(posConfig?.qz_tray_printer_name);
    if (configuredName) {
        try {
            const found = await findQzPrinters(configuredName);
            if (found) {
                return found;
            }
        } catch {
            // best effort fallback below
        }

        try {
            const availablePrinters = await listQzTrayPrinters();
            const closestPrinter = findClosestPrinterName(configuredName, availablePrinters);
            if (closestPrinter) {
                return closestPrinter;
            }
        } catch {
            // continue with default
        }

        try {
            const defaultPrinter = await getQzDefaultPrinter();
            if (defaultPrinter) {
                // Antes caia en silencio: ahora queda el aviso en la consola del navegador
                // para que se pueda ver por que sale por otra impresora (H5).
                console.warn(
                    `[bl_qz_tray_engine] La impresora configurada "${configuredName}" no existe en este equipo; ` +
                        `se imprime en la predeterminada de QZ Tray: "${defaultPrinter}".`
                );
                return defaultPrinter;
            }
        } catch {
            // continue
        }

        return configuredName;
    }

    try {
        return await getQzDefaultPrinter();
    } catch {
        return "";
    }
}

function normalizeBoolean(value, fallback = false) {
    if (typeof value === "boolean") {
        return value;
    }
    if (value === 1 || value === "1" || value === "true") {
        return true;
    }
    if (value === 0 || value === "0" || value === "false") {
        return false;
    }
    return Boolean(fallback);
}

function getTicketCopies(posConfig = {}) {
    const parsed = Number.parseInt(posConfig.qz_ticket_copies, 10);
    const copies = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    return clamp(copies, 1, 10);
}

function getDevicePrinterRows(device) {
    const rows = Array.isArray(device?.printer_ids) ? device.printer_ids : [];
    return rows
        .map((row) => ({
            module_key: normalizePrinterName(row?.module_key),
            printer_name: normalizePrinterName(row?.printer_name),
            copies: clamp(Number.parseInt(row?.copies, 10) || 1, 1, 10),
            force_raw: normalizeBoolean(row?.force_raw, false),
            sequence: Number.parseInt(row?.sequence, 10) || 0,
        }))
        .filter((row) => row.printer_name)
        .sort((left, right) => {
            if (left.sequence !== right.sequence) {
                return left.sequence - right.sequence;
            }
            return left.printer_name.localeCompare(right.printer_name, undefined, {
                sensitivity: "base",
            });
        });
}

export async function resolvePrinterConfigFor(device, posConfig = {}, moduleKey = "") {
    if (!device || !normalizeBoolean(device.qz_enabled, true)) {
        return null;
    }

    // "Misma cantidad para todos": solo con una impresora para todos los modulos.
    const copiesAll =
        device.printer_mode !== "per_module" && normalizeBoolean(device.copies_all, false);
    const sharedCopies = copiesAll
        ? clamp(Number.parseInt(device?.copies, 10) || 1, 1, 10)
        : 1;

    const normalizedModuleKey = normalizePrinterName(moduleKey);
    const rows = getDevicePrinterRows(device);
    if (device.printer_mode === "per_module" && normalizedModuleKey) {
        const moduleRow = rows.find((row) => row.module_key === normalizedModuleKey);
        if (moduleRow) {
            return {
                printer_name: moduleRow.printer_name,
                copies: moduleRow.copies,
                copies_all: false,
                force_raw: moduleRow.force_raw,
            };
        }
    }

    const globalPrinterName = normalizePrinterName(device.printer_name);
    if (globalPrinterName) {
        return {
            printer_name: globalPrinterName,
            copies: sharedCopies,
            copies_all: copiesAll,
            force_raw: normalizeBoolean(device?.force_raw, false),
        };
    }

    const fallbackPrinterName = normalizePrinterName(posConfig?.bl_qz_fallback_printer_name);
    if (fallbackPrinterName) {
        return {
            printer_name: fallbackPrinterName,
            copies: sharedCopies,
            copies_all: copiesAll,
            force_raw: false,
        };
    }

    try {
        const defaultPrinter = normalizePrinterName(await getQzDefaultPrinter());
        if (defaultPrinter) {
            return {
                printer_name: defaultPrinter,
                copies: sharedCopies,
                copies_all: copiesAll,
                force_raw: false,
            };
        }
    } catch {
        // If default printer cannot be resolved, the caller should fallback to native print.
    }

    return null;
}

export function applyEscPosGlobalCenterAlignment(rawEscPosPayload, options = {}) {
    const { prependInitIfMissing = true } = options;
    const payload =
        typeof rawEscPosPayload === "string"
            ? rawEscPosPayload
            : String(rawEscPosPayload || "");

    if (!payload) {
        return payload;
    }

    const hasExplicitAlignment =
        payload.includes(ESC_POS_ALIGN_LEFT) ||
        payload.includes(ESC_POS_ALIGN_CENTER) ||
        payload.includes(ESC_POS_ALIGN_RIGHT);

    if (hasExplicitAlignment) {
        return payload;
    }

    if (payload.includes(ESC_POS_INIT)) {
        return payload.split(ESC_POS_INIT).join(`${ESC_POS_INIT}${ESC_POS_ALIGN_CENTER}`);
    }

    if (!prependInitIfMissing) {
        return `${ESC_POS_ALIGN_CENTER}${payload}`;
    }

    return `${ESC_POS_INIT}${ESC_POS_ALIGN_CENTER}${payload}`;
}

function normalizeRawPayload(rawPayload, applyGlobalCenterAlignment = true) {
    const entries = Array.isArray(rawPayload) ? rawPayload : [rawPayload];
    const normalized = [];

    for (const entry of entries) {
        if (typeof entry === "string") {
            // Un texto vacio no es contenido: antes pasaba el control de "vacio" y se
            // mandaba un trabajo en blanco a la impresora.
            if (!entry.trim()) {
                continue;
            }
            const value = applyGlobalCenterAlignment
                ? applyEscPosGlobalCenterAlignment(entry)
                : entry;
            normalized.push(value);
            continue;
        }
        if (entry !== undefined && entry !== null) {
            normalized.push(entry);
        }
    }

    return normalized;
}

export async function sendRawToQzPrinter(rawPayload, posConfig = {}, options = {}) {
    const qz = await ensureQzSecurityConfigured();

    const effectiveConfig = applyQzWorkstationOverrides(posConfig || {});
    const payload = normalizeRawPayload(rawPayload, options.applyGlobalCenterAlignment !== false);
    if (!payload.length) {
        throw new Error("El contenido a imprimir esta vacio.");
    }

    await ensureConnected(qz);

    const printerName = await resolvePrinterName(qz, effectiveConfig);
    if (!printerName) {
        throw new Error("No hay una impresora de QZ Tray disponible en este equipo.");
    }

    const configOptions = {
        encoding: "Cp1252",
        jobName: options.jobName || "POS ESC/POS",
    };

    const requestedCopies = Number.parseInt(options.copies, 10);
    const copies = Number.isFinite(requestedCopies) && requestedCopies > 0
        ? clamp(requestedCopies, 1, 10)
        : getTicketCopies(effectiveConfig);
    if (copies > 1) {
        configOptions.copies = copies;
    }

    if (normalizeBoolean(options.forceRaw, effectiveConfig.qz_tray_force_raw)) {
        configOptions.forceRaw = true;
    }

    const printOptions = {
        timeoutMs: QZ_PRINT_TIMEOUT_MS,
        fallbackMessage: "No se pudo confirmar la impresion con QZ Tray.",
    };
    let config = qz.configs.create(printerName, configOptions);
    let safeRetryDone = false;
    let attempt = 1;
    for (;;) {
        try {
            await runQzOperation((activeQz) => activeQz.print(config, payload), printOptions);
            return true;
        } catch (error) {
            clearQzPrinterCache();

            // Error ANTES de que QZ Tray reciba el trabajo: reintentar una vez es seguro.
            if (isSafeToRetryPrint(error) && !safeRetryDone) {
                safeRetryDone = true;
                await reconnectSocket(qz);
                // Misma impresora del primer intento: volver a resolver podia caer en la
                // predeterminada y sacar el mismo ticket por otra impresora (N6).
                config = qz.configs.create(printerName, configOptions);
                continue;
            }
            if (!isTransientQzConnectionError(error)) {
                throw error;
            }

            // Corte AMBIGUO: el comprobante pudo haber salido y reenviarlo lo duplicaria (H4).
            // Decide el cajero mirando la impresora; sin pantalla para preguntar, no se reenvia.
            const decision = ambiguousPrintHandler
                ? await ambiguousPrintHandler({
                      jobName: configOptions.jobName,
                      printerName,
                      attempt,
                      error,
                  })
                : "cancel";
            if (decision === "printed") {
                return true;
            }
            if (decision === "retry" && attempt < MAX_AMBIGUOUS_ATTEMPTS) {
                attempt += 1;
                await reconnectSocket(qz);
                config = qz.configs.create(printerName, configOptions);
                continue;
            }
            const ambiguous = new Error(
                "Se cortó la conexión con QZ Tray mientras se imprimía y no se confirmó el comprobante. " +
                    "Revisá si salió antes de volver a imprimir, para no duplicarlo."
            );
            ambiguous.blQzFriendly = true;
            ambiguous.blQzDetail = normalizeQzErrorMessage(error);
            throw ambiguous;
        }
    }
}

export async function sendPixelHtmlToQzPrinter(htmlPayload, posConfig = {}, options = {}) {
    const payload = String(htmlPayload || "").trim();
    if (!payload) {
        throw new Error("El contenido HTML a imprimir esta vacio.");
    }

    return sendRawToQzPrinter(
        [
            {
                type: "pixel",
                format: "html",
                flavor: "plain",
                data: payload,
            },
        ],
        posConfig,
        {
            ...options,
            applyGlobalCenterAlignment: false,
        }
    );
}

export async function sendPixelPdfToQzPrinter(pdfBase64Payload, posConfig = {}, options = {}) {
    const payload = String(pdfBase64Payload || "").trim();
    if (!payload) {
        throw new Error("El PDF a imprimir esta vacio.");
    }

    return sendRawToQzPrinter(
        [
            {
                type: "pixel",
                format: "pdf",
                flavor: "base64",
                data: payload,
            },
        ],
        posConfig,
        {
            ...options,
            applyGlobalCenterAlignment: false,
        }
    );
}

export function isEscPosQzEnabled(posConfig = {}) {
    const deviceEnabled = posConfig?.bl_qz_device?.qz_enabled;
    if (typeof deviceEnabled === "boolean") {
        return deviceEnabled;
    }
    return false;
}

/**
 * Precalienta la conexion QZ (libreria + certificado + websocket + impresora).
 * Best-effort: NUNCA lanza. Si QZ Tray esta cerrado, simplemente devuelve false
 * y el flujo normal de impresion reintenta con su propio manejo de errores.
 */
export async function warmUpQzConnection(posConfig = {}) {
    try {
        const qz = await ensureQzConnection();
        if (posConfig && Object.keys(posConfig).length) {
            await resolvePrinterName(qz, applyQzWorkstationOverrides(posConfig));
        }
        return true;
    } catch (error) {
        console.warn("[bl_qz_tray_engine] QZ warm-up omitido:", error);
        return false;
    }
}
