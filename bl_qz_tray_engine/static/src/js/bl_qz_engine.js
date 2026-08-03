/** @odoo-module */

import { ensureQzSecurityConfigured } from "./bl_qz_security";
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
const QZ_READY_CACHE_TTL_MS = 8000;
let qzReadyCacheTs = 0;

const QZ_TRAY_UNAVAILABLE_MESSAGE =
    "QZ Tray parece estar cerrado o no disponible en este equipo. Abri la aplicacion QZ Tray y reintenta la impresion.";

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
    try {
        if (qz.websocket.isActive()) {
            await qz.websocket.disconnect();
        }
    } catch {
        // Best effort disconnect.
    }

    if (!connectPromise) {
        connectPromise = qz.websocket.connect(CONNECT_OPTIONS).finally(() => {
            connectPromise = null;
        });
    }
    await connectPromise;
    await waitForQzReady(qz);
}

export function getFriendlyQzTrayErrorMessage(error, fallbackMessage = "") {
    const detail = normalizeQzErrorMessage(error);
    const hasHint = detail.toLowerCase().includes(QZ_TRAY_UNAVAILABLE_MESSAGE.toLowerCase());

    if (hasHint) {
        return fallbackMessage ? `${fallbackMessage}\n${detail}` : detail;
    }

    if (isLikelyQzTrayUnavailable(detail)) {
        const unavailableMessage = buildQzTrayUnavailableMessage();
        return fallbackMessage ? `${fallbackMessage}\n${unavailableMessage}` : unavailableMessage;
    }

    if (fallbackMessage && detail) {
        return `${fallbackMessage}\n${detail}`;
    }
    if (fallbackMessage) {
        return fallbackMessage;
    }
    return detail || "No se pudo completar la impresion con QZ Tray.";
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

    for (const printerName of printers) {
        const candidate = normalizePrinterNameForMatch(printerName);
        if (candidate.includes(target) || target.includes(candidate)) {
            return printerName;
        }
    }

    return "";
}

async function ensureConnected(qz) {
    if (!qz.websocket.isActive()) {
        qzReadyCacheTs = 0;
        if (!connectPromise) {
            connectPromise = qz.websocket.connect(CONNECT_OPTIONS).finally(() => {
                connectPromise = null;
            });
        }

        try {
            await connectPromise;
        } catch (error) {
            const detail = normalizeQzErrorMessage(error);
            if (!isTransientQzConnectionError(detail)) {
                throw new Error(buildQzTrayUnavailableMessage(detail));
            }
        }
    }

    const now = Date.now();
    if (now - qzReadyCacheTs < QZ_READY_CACHE_TTL_MS) {
        return;
    }

    try {
        await waitForQzReady(qz);
        qzReadyCacheTs = Date.now();
    } catch (error) {
        qzReadyCacheTs = 0;
        const detail = normalizeQzErrorMessage(error);
        if (!isTransientQzConnectionError(detail)) {
            throw new Error(buildQzTrayUnavailableMessage(detail));
        }
        await reconnectSocket(qz);
        qzReadyCacheTs = Date.now();
    }
}

export async function listQzTrayPrinters() {
    const qz = await ensureQzSecurityConfigured();
    await ensureConnected(qz);

    const result = await qz.printers.find();
    return normalizePrinterList(result);
}

export function clearQzPrinterCache() {
    cachedPrinterKey = "";
    cachedPrinterName = "";
    qzReadyCacheTs = 0;
}

async function resolvePrinterName(qz, posConfig) {
    const configuredName = normalizePrinterName(posConfig?.qz_tray_printer_name);
    const cacheKey = configuredName || "__qz_default_printer__";

    if (cachedPrinterKey === cacheKey && cachedPrinterName) {
        return cachedPrinterName;
    }

    const resolvedPrinterName = await resolvePrinterNameUncached(qz, posConfig);
    if (resolvedPrinterName) {
        cachedPrinterKey = cacheKey;
        cachedPrinterName = resolvedPrinterName;
    }
    return resolvedPrinterName;
}

async function resolvePrinterNameUncached(qz, posConfig) {
    const configuredName = normalizePrinterName(posConfig?.qz_tray_printer_name);
    if (configuredName) {
        try {
            const found = await qz.printers.find(configuredName);
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
            const defaultPrinter = await qz.printers.getDefault();
            if (defaultPrinter) {
                return defaultPrinter;
            }
        } catch {
            // continue
        }

        return configuredName;
    }

    try {
        return await qz.printers.getDefault();
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
        throw new Error("ESC/POS payload is empty.");
    }

    await ensureConnected(qz);

    const printerName = await resolvePrinterName(qz, effectiveConfig);
    if (!printerName) {
        throw new Error("No QZ Tray printer available.");
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

    let config = qz.configs.create(printerName, configOptions);
    try {
        await qz.print(config, payload);
    } catch (error) {
        clearQzPrinterCache();
        if (!isTransientQzConnectionError(error)) {
            throw error;
        }

        await reconnectSocket(qz);
        const retryPrinterName = (await resolvePrinterName(qz, effectiveConfig)) || printerName;
        config = qz.configs.create(retryPrinterName, configOptions);
        await qz.print(config, payload);
    }

    return true;
}

export async function sendPixelHtmlToQzPrinter(htmlPayload, posConfig = {}, options = {}) {
    const payload = String(htmlPayload || "").trim();
    if (!payload) {
        throw new Error("HTML payload is empty.");
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
        throw new Error("PDF payload is empty.");
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
    return Boolean(posConfig && posConfig.receipt_print_escpos);
}

/**
 * Precalienta la conexion QZ (libreria + certificado + websocket + impresora).
 * Best-effort: NUNCA lanza. Si QZ Tray esta cerrado, simplemente devuelve false
 * y el flujo normal de impresion reintenta con su propio manejo de errores.
 */
export async function warmUpQzConnection(posConfig = {}) {
    try {
        const qz = await ensureQzSecurityConfigured();
        await ensureConnected(qz);
        if (posConfig && Object.keys(posConfig).length) {
            await resolvePrinterName(qz, applyQzWorkstationOverrides(posConfig));
        }
        return true;
    } catch (error) {
        console.warn("[bl_qz_tray_engine] QZ warm-up omitido:", error);
        return false;
    }
}
