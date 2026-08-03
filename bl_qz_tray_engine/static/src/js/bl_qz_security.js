/** @odoo-module */

import { loadJS } from "@web/core/assets";
import { rpc } from "@web/core/network/rpc";

const CERTIFICATE_ROUTE = "/bl_qz/certificate";
const SIGN_ROUTE = "/bl_qz/sign";
const QZ_TRAY_LIBRARY_URL = "/bl_qz_tray_engine/static/src/js/qz-tray.js";
const DEFAULT_ALGORITHM = "SHA256";
const ALLOWED_ALGORITHMS = ["SHA1", "SHA256", "SHA512"];

let setupPromise = null;
let qzLibraryPromise = null;
let cachedCertificate = null;
let cachedAlgorithm = DEFAULT_ALGORITHM;

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

async function fetchCertificateAndAlgorithm() {
    const response = await rpc(CERTIFICATE_ROUTE, {});
    const payload = parseCertificateResponse(response);

    if (!payload.certificate || typeof payload.certificate !== "string") {
        throw new Error("No se recibio un certificado valido para QZ Tray.");
    }

    return payload;
}

async function signContent(dataToSign) {
    const response = await rpc(SIGN_ROUTE, { data_to_sign: dataToSign });
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

async function refreshActiveSocketIfNeeded(qz) {
    if (!qz.websocket?.isActive?.()) {
        return;
    }
    if (qz.__blQzSocketRefreshedAfterSecurity) {
        return;
    }

    try {
        await qz.websocket.disconnect();
    } catch {
        // Best effort. Print flow will reconnect.
    }
    qz.__blQzSocketRefreshedAfterSecurity = true;
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
            await refreshActiveSocketIfNeeded(qz);
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
