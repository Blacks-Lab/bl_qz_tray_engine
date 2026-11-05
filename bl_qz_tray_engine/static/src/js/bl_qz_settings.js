/** @odoo-module */

const STORAGE_KEYS = {
    printerName: "bl_qz_tray.printer_name",
    forceRaw: "bl_qz_tray.force_raw",
    copies: "bl_qz_tray.copies",
};

function getLocalStorage() {
    if (typeof window === "undefined") {
        return null;
    }
    try {
        return window.localStorage || null;
    } catch {
        return null;
    }
}

function parseBool(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
        return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
        return false;
    }
    return null;
}

function parseIntOrNull(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

export function getQzWorkstationOverrides() {
    const storage = getLocalStorage();
    if (!storage) {
        return {};
    }

    // Leer el almacenamiento puede lanzar (permisos del navegador): no debe romper la
    // impresion, simplemente no hay ajustes locales.
    let printerNameRaw = null;
    let forceRawRaw = null;
    let copiesRaw = null;
    try {
        printerNameRaw = storage.getItem(STORAGE_KEYS.printerName);
        forceRawRaw = storage.getItem(STORAGE_KEYS.forceRaw);
        copiesRaw = storage.getItem(STORAGE_KEYS.copies);
    } catch {
        return {};
    }

    const printerName = typeof printerNameRaw === "string" ? printerNameRaw.trim() : "";
    const forceRaw = parseBool(forceRawRaw);
    const copies = parseIntOrNull(copiesRaw);

    const overrides = {};
    if (printerName) {
        overrides.qz_tray_printer_name = printerName;
    }
    if (forceRaw !== null) {
        overrides.qz_tray_force_raw = forceRaw;
    }
    if (copies !== null && copies > 0) {
        overrides.qz_ticket_copies = copies;
    }

    return overrides;
}

export function applyQzWorkstationOverrides(posConfig = {}) {
    return {
        ...(posConfig || {}),
        ...getQzWorkstationOverrides(),
    };
}
