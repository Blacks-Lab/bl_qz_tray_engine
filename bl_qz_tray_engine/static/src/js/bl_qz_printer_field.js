/** @odoo-module */

import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Dialog } from "@web/core/dialog/dialog";
import { CharField, charField } from "@web/views/fields/char/char_field";
import { Component } from "@odoo/owl";
import { findQzPrinters, getQzDefaultPrinter } from "./bl_qz_security";

function normalizePrinterName(value) {
    return typeof value === "string" ? value.trim() : "";
}

function uniquePrinterNames(candidates) {
    const names = new Set();
    for (const candidate of candidates) {
        const name = normalizePrinterName(candidate);
        if (name) {
            names.add(name);
        }
    }
    return [...names];
}

function normalizeFindResult(value) {
    if (Array.isArray(value)) {
        return value;
    }
    return value ? [value] : [];
}

function errorMessage(error) {
    return error?.message || _t("No se pudo detectar impresoras con QZ Tray.");
}

export class BlQzPrinterSelectionDialog extends Component {
    static template = "bl_qz_tray_engine.BlQzPrinterSelectionDialog";
    static components = { Dialog };
    static props = {
        close: Function,
        title: { type: String, optional: true },
        printers: Array,
        currentPrinter: { type: String, optional: true },
        defaultPrinter: { type: String, optional: true },
        onSelect: Function,
    };

    setup() {
        this.notification = useService("notification");
    }

    async onSelectPrinter(ev) {
        const printerName = normalizePrinterName(ev.currentTarget?.dataset?.printerName);
        if (!printerName) {
            return;
        }
        try {
            await this.props.onSelect(printerName);
        } catch (error) {
            // Antes el error quedaba sin atrapar y el dialogo abierto sin explicacion (H25).
            this.notification.add(
                error?.message || _t("No se pudo guardar la impresora elegida."),
                { type: "danger" }
            );
            return;
        }
        this.props.close();
    }
}

export class BlQzPrinterField extends CharField {
    static template = "bl_qz_tray_engine.BlQzPrinterField";

    setup() {
        super.setup();
        this.dialog = useService("dialog");
        this.notification = useService("notification");
    }

    async onDetectPrinters() {
        // Un segundo clic mientras detecta (o con el dialogo abierto) abria otro dialogo (H25).
        if (this._blQzDetecting) {
            return;
        }
        this._blQzDetecting = true;
        let dialogOpened = false;
        try {
            // La puerta unica de bl_qz_security.js conecta con tope de tiempo y
            // reconecta sola si QZ Tray devuelve una conexion envenenada.
            const currentPrinter = normalizePrinterName(this.props.record.data[this.props.name]);
            const detected = await findQzPrinters();
            let defaultPrinter = "";
            try {
                defaultPrinter = normalizePrinterName(await getQzDefaultPrinter());
            } catch {
                defaultPrinter = "";
            }
            const printers = uniquePrinterNames([
                ...normalizeFindResult(detected),
                currentPrinter,
                defaultPrinter,
            ]);

            if (!printers.length) {
                this.notification.add(_t("QZ Tray no devolvio impresoras en este equipo."), {
                    type: "warning",
                });
                return;
            }

            dialogOpened = true;
            this.dialog.add(
                BlQzPrinterSelectionDialog,
                {
                    title: _t("Seleccionar impresora QZ"),
                    printers,
                    currentPrinter,
                    defaultPrinter,
                    onSelect: async (selectedPrinter) => {
                        await this.props.record.update({ [this.props.name]: selectedPrinter });
                        this.notification.add(
                            `${_t("Impresora seleccionada")}: ${selectedPrinter}`,
                            { type: "success" }
                        );
                    },
                },
                {
                    onClose: () => {
                        this._blQzDetecting = false;
                    },
                }
            );
        } catch (error) {
            this.notification.add(errorMessage(error), { type: "danger" });
        } finally {
            if (!dialogOpened) {
                this._blQzDetecting = false;
            }
        }
    }
}

export const blQzPrinterField = {
    ...charField,
    component: BlQzPrinterField,
};

registry.category("fields").add("bl_qz_printer", blQzPrinterField);
