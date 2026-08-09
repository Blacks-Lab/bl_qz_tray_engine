/** @odoo-module */

import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Dialog } from "@web/core/dialog/dialog";
import { CharField, charField } from "@web/views/fields/char/char_field";
import { Component } from "@odoo/owl";
import { ensureQzSecurityConfigured } from "./bl_qz_security";

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

    async onSelectPrinter(ev) {
        const printerName = normalizePrinterName(ev.currentTarget?.dataset?.printerName);
        if (!printerName) {
            return;
        }
        await this.props.onSelect(printerName);
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
        try {
            const qz = await ensureQzSecurityConfigured();
            if (!qz) {
                this.notification.add(
                    _t("QZ Tray no esta cargado en backend. Verifique web.assets_backend."),
                    { type: "danger" }
                );
                return;
            }

            if (!qz.websocket?.isActive?.()) {
                await qz.websocket.connect({ retries: 2, delay: 0.3 });
            }

            const currentPrinter = normalizePrinterName(this.props.record.data[this.props.name]);
            const detected = await qz.printers.find();
            const defaultPrinter = normalizePrinterName(await qz.printers.getDefault());
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

            this.dialog.add(BlQzPrinterSelectionDialog, {
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
            });
        } catch (error) {
            this.notification.add(errorMessage(error), { type: "danger" });
        }
    }
}

export const blQzPrinterField = {
    ...charField,
    component: BlQzPrinterField,
};

registry.category("fields").add("bl_qz_printer", blQzPrinterField);
