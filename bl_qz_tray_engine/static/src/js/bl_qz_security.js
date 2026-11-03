/** @odoo-module */

import { loadJS } from "@web/core/assets";
import { rpc } from "@web/core/network/rpc";

const CERTIFICATE_ROUTE = "/bl_qz/certificate";
const SIGN_ROUTE = "/bl_qz/sign";
// El parametro de version obliga al navegador a bajar la copia parcheada:
// Odoo sirve los archivos estaticos con cache de 7 dias (odoo/http.py STATIC_CACHE).
// Cambiarlo cada vez que se toque qz-tray.js.
const QZ_TRAY_LIBRARY_URL = "/bl_qz_tray_engine/static/src/js/qz-tray.js?v=bl-qz-patch-2";
const DEFAULT_ALGORITHM = "SHA256";
const ALLOWED_ALGORITHMS = ["SHA1", "SHA256", "SHA512"];

// Puerta unica de conexion con QZ Tray: todo el modulo (campo, panel y motor del
// TPV) conecta por aca, con tope de tiempo y reconexion ante conexion envenenada.
// HANDSHAKE incluye el dialogo "Allow" de la app QZ Tray (medido: ~3 s).
// READY repite el TTL de 8 s que ya usaba bl_qz_engine.js.
// CALL: printers.find con 9 impresoras tardo 656 ms. PRINT: el spool o el
// rasterizado pueden tardar mas que una consulta.
const HANDSHAKE_TIMEOUT_MS = 20000;
const READY_TIMEOUT_MS = 8000;
const CALL_TIMEOUT_MS = 10000;
export const QZ_PRINT_TIMEOUT_MS = 30000;
const DISCONNECT_TIMEOUT_MS = 3000;
const READY_CACHE_TTL_MS = 8000;
// Espera antes de reconectar: separa la conexion nueva del cierre de la vieja y
// reparte en el tiempo a las pestanias que reconectan a la vez.
const RECONNECT_MIN_DELAY_MS = 100;
const RECONNECT_JITTER_MS = 400;
// Sin reintentos de la libreria: el reintento lo decide la puerta, despues de
// cerrar el socket envenenado.
const CONNECT_OPTIONS = { retries: 0, delay: 0 };

export const QZ_CONNECTION_MESSAGES = {
    closed: "No se pudo conectar con QZ Tray. Abri la aplicacion QZ Tray en este equipo y reintenta.",
    lost: "Se corto la conexion con QZ Tray. Reintenta en unos segundos.",
    blocked:
        "La conexion con QZ Tray quedo esperando una autorizacion. Revisa el aviso del navegador y la ventana de QZ Tray, acepta el acceso y reintenta.",
    busy: "Ya hay una conexion con QZ Tray en curso. Espera unos segundos y reintenta.",
    poisoned:
        "QZ Tray respondio con un error interno y no se pudo recuperar la conexion. Reintenta en unos segundos; si se repite, reinicia QZ Tray.",
    timeout:
        "QZ Tray no respondio a tiempo. Revisa que la aplicacion este abierta y que el navegador le permita conectarse a este equipo, y reintenta.",
    requestBlocked: "QZ Tray bloqueo el pedido. Revisa los permisos en la ventana de QZ Tray y reintenta.",
    printerNotFound:
        "La impresora configurada no existe en este equipo. Elegi otra impresora en la configuracion del equipo.",
    generic: "No se pudo completar la operacion con QZ Tray.",
};

let setupPromise = null;
let qzLibraryPromise = null;
let cachedCertificate = null;
let cachedAlgorithm = DEFAULT_ALGORITHM;

// Estado propio de la puerta: la libreria solo expone isActive(), que en 2.2.5
// cuenta CONNECTING como activo.
let gatePromise = null;
let recoverPromise = null;
let socketOpened = false;
let socketGeneration = 0;
let socketCertificate = null;
let readyAt = 0;

function getQz() {
    if (typeof globalThis !== "undefined" && globalThis.qz) {
        return globalThis.qz;
    }
    if (typeof window !== "undefined" && window.qz) {
        return window.qz;
    }
    return null;
}

async function ensureQzLibraryLoaded() {
    const availableQz = getQz();
    if (availableQz) {
        return availableQz;
    }

    if (!qzLibraryPromise) {
        qzLibraryPromise = (async () => {
            try {
                await loadJS(QZ_TRAY_LIBRARY_URL);
            } catch (error) {
                const detail = normalizeErrorMessage(error, "");
                if (detail) {
                    throw new Error(
                        `No se pudo cargar qz-tray.js (${QZ_TRAY_LIBRARY_URL}). ${detail}`
                    );
                }
                throw new Error(`No se pudo cargar qz-tray.js (${QZ_TRAY_LIBRARY_URL}).`);
            }

            const loadedQz = getQz();
            if (!loadedQz) {
                throw new Error(
                    "QZ Tray no quedo disponible en window.qz luego de cargar qz-tray.js."
                );
            }

            return loadedQz;
        })().finally(() => {
            qzLibraryPromise = null;
        });
    }

    return qzLibraryPromise;
}

function normalizeAlgorithm(value) {
    const normalized = String(value || DEFAULT_ALGORITHM).toUpperCase();
    return ALLOWED_ALGORITHMS.includes(normalized) ? normalized : DEFAULT_ALGORITHM;
}

function normalizeErrorMessage(error, fallback) {
    if (error?.message) {
        return error.message;
    }
    if (error?.data?.message) {
        return error.data.message;
    }
    if (typeof error === "string") {
        return error;
    }
    return fallback;
}

function parseCertificateResponse(response) {
    if (typeof response === "string") {
        return {
            certificate: response,
            algorithm: DEFAULT_ALGORITHM,
        };
    }

    return {
        certificate: response?.certificate || "",
        algorithm: normalizeAlgorithm(response?.algorithm),
    };
}

function parseSignatureResponse(response) {
    if (typeof response === "string") {
        return response;
    }
    return response?.signature || "";
}

function getActivePosConfigId() {
    const fromOdooGlobal = Number.parseInt(globalThis?.odoo?.pos_config_id, 10);
    if (Number.isFinite(fromOdooGlobal) && fromOdooGlobal > 0) {
        return fromOdooGlobal;
    }

    try {
        const search = typeof window !== "undefined" ? window.location?.search || "" : "";
        const fromQuery = Number.parseInt(new URLSearchParams(search).get("config_id"), 10);
        if (Number.isFinite(fromQuery) && fromQuery > 0) {
            return fromQuery;
        }
    } catch {
        // Ignore URL parsing issues and fallback to empty payload.
    }

    return 0;
}

function buildSigningPayload(extra = {}) {
    const payload = { ...extra };
    const posConfigId = getActivePosConfigId();
    if (posConfigId > 0) {
        payload.pos_config_id = posConfigId;
    }
    return payload;
}

async function fetchCertificateAndAlgorithm() {
    const response = await rpc(CERTIFICATE_ROUTE, buildSigningPayload());
    const payload = parseCertificateResponse(response);

    if (!payload.certificate || typeof payload.certificate !== "string") {
        throw new Error("No se recibio un certificado valido para QZ Tray.");
    }

    return payload;
}

async function signContent(dataToSign) {
    const response = await rpc(
        SIGN_ROUTE,
        buildSigningPayload({ data_to_sign: dataToSign })
    );
    const signature = parseSignatureResponse(response);

    if (!signature || typeof signature !== "string") {
        throw new Error("No se recibio una firma valida desde Odoo para QZ Tray.");
    }

    return signature;
}

function applySecurityHandlers(qz) {
    qz.security.setCertificatePromise(async () => cachedCertificate, { rejectOnFailure: true });
    qz.security.setSignatureAlgorithm(cachedAlgorithm);
    qz.security.setSignaturePromise(async (dataToSign) => signContent(dataToSign));
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function reconnectDelay() {
    return RECONNECT_MIN_DELAY_MS + Math.floor(Math.random() * RECONNECT_JITTER_MS);
}

function timeoutError(label) {
    const error = new Error(`QZ Tray timeout (${label})`);
    error.blQzTimeout = true;
    return error;
}

function withTimeout(promise, ms, label) {
    const guarded = Promise.resolve(promise);
    // Si gana el tope, la promesa original puede rechazar despues: sin este
    // handler quedaria un rechazo sin capturar.
    guarded.catch(() => {});
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError(label)), Math.max(1, ms));
    });
    return Promise.race([guarded, timeout]).finally(() => {
        clearTimeout(timer);
    });
}

function rawDetail(error) {
    if (typeof error?.blQzDetail === "string" && error.blQzDetail) {
        return error.blQzDetail;
    }
    return normalizeErrorMessage(error, "") || "";
}

function isPoisonedError(error) {
    return rawDetail(error).toLowerCase().includes("nullpointerexception");
}

function friendlyError(message, cause) {
    const error = new Error(message);
    error.blQzFriendly = true;
    error.blQzDetail = rawDetail(cause);
    if (cause?.blQzTimeout) {
        error.blQzTimeout = true;
    }
    return error;
}

/**
 * Traduce un error de QZ Tray (crudo, en ingles) a un mensaje en espanol para
 * mostrar. El detalle crudo queda solo en la consola.
 */
export function describeQzConnectionError(error, fallbackMessage = "") {
    let message = "";
    if (error?.blQzFriendly) {
        message = error.message;
    } else {
        const detail = rawDetail(error);
        const lower = detail.toLowerCase();
        if (lower.includes("nullpointerexception")) {
            message = QZ_CONNECTION_MESSAGES.poisoned;
        } else if (error?.blQzTimeout) {
            message = QZ_CONNECTION_MESSAGES.timeout;
        } else if (
            lower.includes("unable to establish connection") ||
            lower.includes("no open connection") ||
            lower.includes("has not been established")
        ) {
            message = QZ_CONNECTION_MESSAGES.closed;
        } else if (lower.includes("closed before response")) {
            message = QZ_CONNECTION_MESSAGES.lost;
        } else if (
            lower.includes("cancelled by user") ||
            lower.includes("blocked by client") ||
            lower.includes("local network access")
        ) {
            message = QZ_CONNECTION_MESSAGES.blocked;
        } else if (
            lower.includes("not returned yet") ||
            lower.includes("previous disconnect") ||
            lower.includes("already exists") ||
            lower.includes("still closing")
        ) {
            message = QZ_CONNECTION_MESSAGES.busy;
        } else if (lower.includes("request blocked")) {
            message = QZ_CONNECTION_MESSAGES.requestBlocked;
        } else if (lower.includes("could not be found")) {
            message = QZ_CONNECTION_MESSAGES.printerNotFound;
        } else {
            message = QZ_CONNECTION_MESSAGES.generic;
        }
        if (detail) {
            console.warn("[bl_qz_tray_engine] Detalle de QZ Tray:", detail);
        }
    }
    return fallbackMessage ? `${fallbackMessage}\n${message}` : message;
}

function qzIsActive(qz) {
    try {
        return Boolean(qz?.websocket?.isActive?.());
    } catch {
        return false;
    }
}

async function closeSocket(qz) {
    const wasActive = socketOpened || qzIsActive(qz);
    socketOpened = false;
    socketCertificate = null;
    readyAt = 0;
    if (!wasActive) {
        return;
    }
    try {
        await withTimeout(qz.websocket.disconnect(), DISCONNECT_TIMEOUT_MS, "disconnect");
    } catch {
        // Mejor esfuerzo: si el cierre no contesta, la proxima conexion reintenta.
    }
}

async function openSocket(qz) {
    if (qzIsActive(qz)) {
        // Socket abierto por otro codigo de la misma pagina (p. ej. la prueba de
        // logo de l10n_ar_pos_einvoice_ticket, que usa la misma libreria): se
        // adopta y se verifica con getVersion en vez de chocar con el.
        socketOpened = true;
        socketCertificate = cachedCertificate;
        socketGeneration += 1;
        return true;
    }
    await withTimeout(
        qz.websocket.connect({ ...CONNECT_OPTIONS }),
        HANDSHAKE_TIMEOUT_MS,
        "connect"
    );
    socketOpened = true;
    socketCertificate = cachedCertificate;
    socketGeneration += 1;
    return false;
}

async function openAndVerify(qz) {
    for (let attempt = 0; ; attempt += 1) {
        let adopted = false;
        try {
            if (!(socketOpened && qzIsActive(qz))) {
                adopted = await openSocket(qz);
            }
            await withTimeout(qz.api.getVersion(), READY_TIMEOUT_MS, "getVersion");
            readyAt = Date.now();
            return;
        } catch (error) {
            if (isPoisonedError(error) && attempt === 0) {
                // QZ Tray perdio el registro de esta conexion (carrera de su HashMap
                // con dos conexiones simultaneas): se cierra y se abre UNA nueva.
                console.warn(
                    "[bl_qz_tray_engine] Conexion con QZ Tray envenenada (NullPointerException): se reconecta una vez."
                );
                await closeSocket(qz);
                await wait(reconnectDelay());
                continue;
            }
            if (error?.blQzTimeout) {
                await closeSocket(qz);
            } else if (adopted && !isPoisonedError(error)) {
                // El socket ajeno todavia estaba conectando.
                socketOpened = false;
                throw friendlyError(QZ_CONNECTION_MESSAGES.busy, error);
            }
            throw friendlyError(describeQzConnectionError(error), error);
        }
    }
}

/** Puerta unica: deja el socket abierto y verificado, o lanza un error en espanol. */
export async function ensureQzConnection() {
    const qz = await ensureQzSecurityConfigured();
    if (socketOpened && qzIsActive(qz) && Date.now() - readyAt < READY_CACHE_TTL_MS) {
        return qz;
    }
    if (!gatePromise) {
        gatePromise = openAndVerify(qz).finally(() => {
            gatePromise = null;
        });
    }
    await gatePromise;
    return qz;
}

async function recoverPoisonedSocket(qz, generation) {
    if (generation === socketGeneration && !recoverPromise) {
        recoverPromise = (async () => {
            console.warn(
                "[bl_qz_tray_engine] Llamada a QZ Tray con NullPointerException: se reconecta una vez."
            );
            await closeSocket(qz);
            await wait(reconnectDelay());
        })().finally(() => {
            recoverPromise = null;
        });
    }
    if (recoverPromise) {
        await recoverPromise;
    }
    // Si otra llamada ya reemplazo el socket, solo se verifica el actual.
    await ensureQzConnection();
}

async function callQz(qz, operation, timeoutMs, fallbackMessage) {
    const generation = socketGeneration;
    try {
        return await withTimeout(Promise.resolve().then(() => operation(qz)), timeoutMs, "call");
    } catch (error) {
        if (!isPoisonedError(error)) {
            throw friendlyError(describeQzConnectionError(error, fallbackMessage), error);
        }
    }
    await recoverPoisonedSocket(qz, generation);
    try {
        return await withTimeout(Promise.resolve().then(() => operation(qz)), timeoutMs, "call");
    } catch (retryError) {
        throw friendlyError(describeQzConnectionError(retryError, fallbackMessage), retryError);
    }
}

/**
 * Ejecuta operation(qz) sobre la conexion de la puerta, con tope de tiempo y un
 * reintento si QZ Tray contesta NullPointerException (el error nace en
 * PrintSocketClient antes de despachar el pedido, asi que no duplica impresiones).
 */
export async function runQzOperation(operation, options = {}) {
    const qz = await ensureQzConnection();
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : CALL_TIMEOUT_MS;
    return callQz(qz, operation, timeoutMs, options.fallbackMessage || "");
}

export async function findQzPrinters(query = "") {
    return runQzOperation((qz) => (query ? qz.printers.find(query) : qz.printers.find()));
}

export async function getQzDefaultPrinter() {
    return runQzOperation((qz) => qz.printers.getDefault());
}

async function refreshSocketAfterSecurityChange(qz) {
    // Solo un socket que la puerta abrio y con otro certificado. Nunca uno que
    // todavia conecta: desconectarlo dejaba la pestania muerta.
    if (!socketOpened || !qzIsActive(qz)) {
        return;
    }
    if (socketCertificate === cachedCertificate) {
        return;
    }
    await closeSocket(qz);
}

export async function ensureQzSecurityConfigured() {
    const qz = await ensureQzLibraryLoaded();

    if (!setupPromise) {
        setupPromise = (async () => {
            if (!cachedCertificate) {
                const payload = await fetchCertificateAndAlgorithm();
                cachedCertificate = payload.certificate;
                cachedAlgorithm = payload.algorithm;
            }

            applySecurityHandlers(qz);
            await refreshSocketAfterSecurityChange(qz);
            qz.__blQzSecurityConfigured = true;
            return qz;
        })()
            .catch((error) => {
                if (qz) {
                    qz.__blQzSecurityConfigured = false;
                }
                throw new Error(
                    normalizeErrorMessage(error, "No se pudo inicializar la firma de seguridad para QZ Tray.")
                );
            })
            .finally(() => {
                setupPromise = null;
            });
    }

    const activeSetupPromise = setupPromise;
    const configuredQz = await activeSetupPromise;
    if (!configuredQz) {
        throw new Error("No se pudo inicializar la seguridad de QZ Tray.");
    }

    // setupPromise ya deja la seguridad configurada para el flujo normal.
    if (!configuredQz.__blQzSecurityConfigured) {
        throw new Error("No se pudo inicializar la seguridad de QZ Tray.");
    }

    return configuredQz;
}
