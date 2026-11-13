/** @odoo-module */

import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { Dialog } from "@web/core/dialog/dialog";
import { useService } from "@web/core/utils/hooks";
import { standardWidgetProps } from "@web/views/widgets/standard_widget_props";
import { Component, onWillStart, onWillUnmount, useState } from "@odoo/owl";

import { findQzPrinters, getQzDefaultPrinter } from "./bl_qz_security";

const DEVICE_UUID_KEY = "bl_qz_device_uuid";
const MODULE_ROWS = [
    { module_key: "fiscal", label: "fiscal", sequence: 10 },
    { module_key: "retiro", label: "retiro", sequence: 20 },
    { module_key: "comanda", label: "comanda", sequence: 30 },
    { module_key: "mozo", label: "mozo", sequence: 40 },
    { module_key: "pago_proveedor", label: "pago_proveedor", sequence: 50 },
];

function normalizeString(value) {
    return typeof value === "string" ? value.trim() : "";
}

function parseCopies(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return 1;
    }
    return Math.max(1, Math.min(10, parsed));
}

// Si el navegador no deja guardar datos el identificador se recuerda en memoria: sin esto cada
// llamada generaba uno nuevo y el servidor creaba un equipo por cada carga (H9).
let memoryUuid = "";

function ensureUuid() {
    let current = "";
    try {
        current = normalizeString(window.localStorage.getItem(DEVICE_UUID_KEY));
    } catch {
        current = "";
    }
    if (current) {
        return current;
    }
    if (memoryUuid) {
        return memoryUuid;
    }

    let generated = "";
    try {
        generated = window.crypto?.randomUUID?.() || "";
    } catch {
        generated = "";
    }
    if (!generated) {
        generated = `qz-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    memoryUuid = generated;
    try {
        window.localStorage.setItem(DEVICE_UUID_KEY, generated);
    } catch {
        // localStorage can fail on hardened browsers.
    }
    return generated;
}

function normalizePrinterRows(rows) {
    const byKey = new Map();
    const sourceRows = Array.isArray(rows) ? rows : [];

    for (const row of sourceRows) {
        const key = normalizeString(row?.module_key);
        if (!key || byKey.has(key)) {
            continue;
        }
        byKey.set(key, {
            module_key: key,
            printer_name: normalizeString(row?.printer_name),
            copies: parseCopies(row?.copies),
            force_raw: Boolean(row?.force_raw),
            sequence: Number.parseInt(row?.sequence, 10) || 10,
        });
    }

    return MODULE_ROWS.map((moduleRow) => {
        const existing = byKey.get(moduleRow.module_key);
        return {
            module_key: moduleRow.module_key,
            label: moduleRow.label,
            printer_name: existing?.printer_name || "",
            copies: existing?.copies || 1,
            force_raw: Boolean(existing?.force_raw),
            sequence: existing?.sequence || moduleRow.sequence,
        };
    });
}

function normalizePrinterCandidates(detected, currentPrinter) {
    const values = [];
    if (Array.isArray(detected)) {
        values.push(...detected);
    } else {
        values.push(detected);
    }
    values.push(currentPrinter);

    const dedup = new Set();
    for (const value of values) {
        const printer = normalizeString(value);
        if (printer) {
            dedup.add(printer);
        }
    }
    return Array.from(dedup);
}

function normalizePrinterChoices(detected, currentPrinter, defaultPrinter) {
    const currentName = normalizeString(currentPrinter);
    const defaultName = normalizeString(defaultPrinter);
    const printers = normalizePrinterCandidates(detected, currentName);

    if (defaultName && !printers.includes(defaultName)) {
        printers.unshift(defaultName);
    }

    return printers.map((name) => ({
        name,
        isCurrent: Boolean(currentName && currentName === name),
        isDefault: Boolean(defaultName && defaultName === name),
    }));
}

class BlQzDevicePrinterDialog extends Component {
    static template = "bl_qz_tray_engine.BlQzDevicePrinterDialog";
    static components = { Dialog };
    static props = {
        close: Function,
        title: { type: String, optional: true },
        printers: Array,
        onSelect: Function,
    };

    setup() {
        this._resolved = false;
        onWillUnmount(() => {
            this._resolveSelection("");
        });
    }

    _resolveSelection(value) {
        if (this._resolved) {
            return;
        }
        this._resolved = true;
        this.props.onSelect(value);
    }

    onSelectPrinter(ev) {
        const printerName = normalizeString(ev.currentTarget?.dataset?.printerName);
        if (!printerName) {
            return;
        }
        this._resolveSelection(printerName);
        this.props.close();
    }

    onCancelDialog() {
        this._resolveSelection("");
        this.props.close();
    }
}

export class BlQzDevicePanel extends Component {
    static template = "bl_qz_tray_engine.BlQzDevicePanel";
    static props = {
        ...standardWidgetProps,
        basic: { type: Boolean, optional: true },
    };

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.dialog = useService("dialog");
        this.notification = useService("notification");

        this.state = useState({
            loading: true,
            saving: false,
            detecting: false,
            error: "",
            canDownload: false,
            canGenerate: false,
            device: null,
            device_name: "",
            qz_enabled: true,
            printer_mode: "global",
            printer_name: "",
            copies: 1,
            copies_all: false,
            force_raw: false,
            module_rows: normalizePrinterRows([]),
        });

        onWillStart(async () => {
            await this._loadDevice();
        });
    }

    get isPerModule() {
        return this.state.printer_mode === "per_module";
    }

    // Numeracion de las opciones. En la configuracion base (basic) no esta el interruptor de
    // habilitar QZ: lo cambia solo el administrador desde Ajustes generales.
    get nums() {
        const shift = this.props.basic ? 0 : 1;
        const printer = 3 + shift;
        return {
            enabled: 1,
            name: 1 + shift,
            mode: 2 + shift,
            printer,
            copies: printer + 1,
            force: printer + 2,
            tests: this.isPerModule ? printer + 1 : printer + 3,
        };
    }

    async _loadDevice() {
        this.state.loading = true;
        this.state.error = "";
        try {
            const deviceUuid = ensureUuid();
            const defaultName = `Equipo ${deviceUuid.slice(0, 8)}`;
            const device = await this.orm.call("bl.qz.device", "bl_qz_resolve_device", [
                deviceUuid,
                defaultName,
            ]);
            this._setDeviceState(device);
        } catch (error) {
            this.state.error = error?.message || _t("No se pudo cargar la configuracion del equipo.");
        } finally {
            this.state.loading = false;
        }
    }

    _setDeviceState(device) {
        this.state.device = device || null;
        this.state.device_name = normalizeString(device?.name) || "";
        this.state.qz_enabled = device?.qz_enabled !== false;
        this.state.printer_mode = device?.printer_mode === "per_module" ? "per_module" : "global";
        this.state.printer_name = normalizeString(device?.printer_name);
        this.state.copies = parseCopies(device?.copies);
        this.state.copies_all = Boolean(device?.copies_all);
        this.state.force_raw = Boolean(device?.force_raw);
        this.state.canDownload = Boolean(device?.can_download_certificate);
        this.state.canGenerate = Boolean(device?.can_generate_certificate);
        this.state.module_rows = normalizePrinterRows(device?.printer_ids);
    }

    _buildPrinterCommands() {
        const commands = [[5, 0, 0]];
        for (const row of this.state.module_rows) {
            commands.push([
                0,
                0,
                {
                    module_key: row.module_key,
                    printer_name: normalizeString(row.printer_name),
                    copies: parseCopies(row.copies),
                    force_raw: Boolean(row.force_raw),
                    sequence: row.sequence,
                },
            ]);
        }
        return commands;
    }

    // Guardado en cola (H17): si el usuario cambia otro control mientras se guarda, no se
    // lanza un segundo write en paralelo (se pisaban entre si y el orden de llegada al
    // servidor no estaba garantizado); se guarda UNA vez mas al terminar, con el estado final.
    async _saveDevice() {
        if (this._blQzSaving) {
            this._blQzSavePending = true;
            return;
        }
        this._blQzSaving = true;
        try {
            do {
                this._blQzSavePending = false;
                await this._saveDeviceNow();
            } while (this._blQzSavePending);
        } finally {
            this._blQzSaving = false;
        }
    }

    async _saveDeviceNow() {
        const device = this.state.device;
        if (!device?.id) {
            return;
        }

        this.state.saving = true;
        this.state.error = "";
        try {
            await this.orm.write("bl.qz.device", [device.id], {
                name: normalizeString(this.state.device_name) || `Equipo ${device.device_uuid.slice(0, 8)}`,
                qz_enabled: Boolean(this.state.qz_enabled),
                printer_mode: this.state.printer_mode,
                printer_name: normalizeString(this.state.printer_name),
                copies: parseCopies(this.state.copies),
                copies_all: Boolean(this.state.copies_all),
                force_raw: Boolean(this.state.force_raw),
                printer_ids: this._buildPrinterCommands(),
            });

            const refreshed = await this.orm.call("bl.qz.device", "bl_qz_resolve_device", [
                device.device_uuid,
                normalizeString(this.state.device_name) || `Equipo ${device.device_uuid.slice(0, 8)}`,
            ]);
            // Si el usuario cambio otro control mientras se guardaba, la respuesta del servidor
            // todavia no trae ese cambio: no se pisa la pantalla; se aplica tras el ultimo guardado.
            if (!this._blQzSavePending) {
                this._setDeviceState(refreshed);
            }
            this.notification.add(_t("Configuracion del equipo guardada."), { type: "success" });
        } catch (error) {
            this.state.error = error?.message || _t("No se pudo guardar la configuracion del equipo.");
            this.notification.add(this.state.error, { type: "danger" });
            // Si el usuario ya cambio otra cosa mientras se guardaba, NO se vuelve a lo del
            // servidor (perderia ese cambio): el guardado que sigue manda la fila completa.
            if (this._blQzSavePending) {
                return;
            }
            // La pantalla ya mostraba el valor nuevo aunque no se guardo: se vuelve a leer lo
            // que realmente tiene el servidor para no mostrar un dato falso (H17).
            try {
                const current = await this.orm.call("bl.qz.device", "bl_qz_resolve_device", [
                    device.device_uuid,
                    normalizeString(this.state.device_name) || `Equipo ${device.device_uuid.slice(0, 8)}`,
                ]);
                this._setDeviceState(current);
            } catch {
                // sin conexion: queda el aviso de error
            }
        } finally {
            this.state.saving = false;
        }
    }

    onDeviceNameChange(ev) {
        this.state.device_name = normalizeString(ev.target.value);
        this._saveDevice();
    }

    onEnabledChange(ev) {
        this.state.qz_enabled = Boolean(ev.target.checked);
        this._saveDevice();
    }

    onModeGlobalChange() {
        this.state.printer_mode = "global";
        this._saveDevice();
    }

    onModePerModuleChange() {
        this.state.printer_mode = "per_module";
        this._saveDevice();
    }

    onGlobalPrinterChange(ev) {
        this.state.printer_name = normalizeString(ev.target.value);
        this._saveDevice();
    }

    onCopiesAllChange(ev) {
        this.state.copies_all = Boolean(ev.target?.checked);
        this._saveDevice();
    }

    onGlobalCopiesChange(ev) {
        this.state.copies = parseCopies(ev.target?.value);
        this._saveDevice();
    }

    onGlobalForceRawChange(ev) {
        this.state.force_raw = Boolean(ev.target?.checked);
        this._saveDevice();
    }

    onModulePrinterChange(ev) {
        const moduleKey = ev.currentTarget?.dataset?.moduleKey || "";
        const normalized = normalizeString(ev.target?.value);
        if (!moduleKey) {
            return;
        }
        this.state.module_rows = this.state.module_rows.map((row) =>
            row.module_key === moduleKey ? { ...row, printer_name: normalized } : row
        );
        this._saveDevice();
    }

    onModuleCopiesChange(ev) {
        const moduleKey = ev.currentTarget?.dataset?.moduleKey || "";
        if (!moduleKey) {
            return;
        }
        const copies = parseCopies(ev.target?.value);
        this.state.module_rows = this.state.module_rows.map((row) =>
            row.module_key === moduleKey ? { ...row, copies } : row
        );
        this._saveDevice();
    }

    onModuleForceRawChange(ev) {
        const moduleKey = ev.currentTarget?.dataset?.moduleKey || "";
        if (!moduleKey) {
            return;
        }
        const checked = Boolean(ev.target?.checked);
        this.state.module_rows = this.state.module_rows.map((row) =>
            row.module_key === moduleKey ? { ...row, force_raw: Boolean(checked) } : row
        );
        this._saveDevice();
    }

    async _pickDetectedPrinter(currentPrinter = "") {
        // La puerta unica de bl_qz_security.js tiene tope de tiempo: el finally de
        // onDetectPrinters siempre libera "detecting".
        const detected = await findQzPrinters();
        let defaultPrinter = "";
        try {
            defaultPrinter = await getQzDefaultPrinter();
        } catch {
            defaultPrinter = "";
        }
        const printers = normalizePrinterChoices(detected, currentPrinter, defaultPrinter);

        if (!printers.length) {
            this.notification.add(_t("QZ Tray no devolvio impresoras en este equipo."), {
                type: "warning",
            });
            return "";
        }

        return await new Promise((resolve) => {
            this.dialog.add(BlQzDevicePrinterDialog, {
                title: _t("Impresoras detectadas por QZ Tray"),
                printers,
                onSelect: (selectedPrinter) => resolve(selectedPrinter || ""),
            });
        });
    }

    async onDetectPrinters() {
        if (this.isPerModule || this.state.detecting) {
            return;
        }

        this.state.detecting = true;
        try {
            const selectedPrinter = await this._pickDetectedPrinter(this.state.printer_name);
            if (!selectedPrinter) {
                return;
            }
            this.state.printer_name = selectedPrinter;
            await this._saveDevice();
        } catch (error) {
            const message = error?.message || _t("No se pudo detectar impresoras con QZ Tray.");
            this.notification.add(message, { type: "danger" });
        } finally {
            this.state.detecting = false;
        }
    }

    async onDetectModulePrinter(ev) {
        if (!this.isPerModule || this.state.detecting) {
            return;
        }
        const moduleKey = ev.currentTarget?.dataset?.moduleKey || "";
        if (!moduleKey) {
            return;
        }

        const currentRow = this.state.module_rows.find((row) => row.module_key === moduleKey);
        this.state.detecting = true;
        try {
            const selectedPrinter = await this._pickDetectedPrinter(currentRow?.printer_name || "");
            if (!selectedPrinter) {
                return;
            }
            this.state.module_rows = this.state.module_rows.map((row) =>
                row.module_key === moduleKey ? { ...row, printer_name: selectedPrinter } : row
            );
            await this._saveDevice();
        } catch (error) {
            const message = error?.message || _t("No se pudo detectar impresoras con QZ Tray.");
            this.notification.add(message, { type: "danger" });
        } finally {
            this.state.detecting = false;
        }
    }

    async _runDeviceAction(methodName) {
        if (!this.state.device?.id) {
            return;
        }
        try {
            const result = await this.orm.call("bl.qz.device", methodName, [[this.state.device.id]]);
            if (result) {
                await this.action.doAction(result);
            }
        } catch (error) {
            const message = error?.message || _t("No se pudo ejecutar la accion solicitada.");
            this.notification.add(message, { type: "danger" });
        }
    }

    onPrintHeaderTest() {
        return this._runDeviceAction("action_print_qz_logo_header_test");
    }

    onDownloadCertificate() {
        return this._runDeviceAction("action_download_qz_signing_certificate");
    }

    onGenerateCertificate() {
        return this._runDeviceAction("action_generate_qz_signing_material");
    }
}

registry.category("view_widgets").add("bl_qz_device_panel", {
    component: BlQzDevicePanel,
    extractProps: ({ options }) => ({ basic: Boolean(options && options.basic) }),
});
