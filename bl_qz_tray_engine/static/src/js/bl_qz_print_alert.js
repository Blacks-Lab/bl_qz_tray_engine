/** @odoo-module */

import { Component } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";

/**
 * Aviso "posible falla de comunicacion con la impresora".
 *
 * Aparece cuando la conexion con QZ Tray se corta justo cuando el comprobante pudo haber salido:
 * reenviarlo solo podria imprimirlo dos veces, asi que decide el cajero mirando la impresora.
 * Tiene el mismo estilo visual que la seccion "Modulos BlackLabs" (bl_modules_section.scss).
 *
 * Decision que devuelve a quien lo abre: "retry" (reintentar), "printed" (ya se imprimio)
 * o "cancel" (cerro el aviso sin elegir).
 */
export class BlQzPrintAlertDialog extends Component {
    static template = "bl_qz_tray_engine.BlQzPrintAlertDialog";
    static components = { Dialog };
    static props = {
        close: Function,
        jobName: { type: String, optional: true },
        printerName: { type: String, optional: true },
        attempt: { type: Number, optional: true },
        onDecision: Function,
    };

    setup() {
        this._decided = false;
    }

    get attemptText() {
        const done = (this.props.attempt || 1) - 1;
        if (done < 1) {
            return "";
        }
        return done === 1
            ? "Ya se reintentó una vez y volvió a cortarse."
            : `Ya se reintentó ${done} veces y volvió a cortarse.`;
    }

    decide(value) {
        if (this._decided) {
            return;
        }
        this._decided = true;
        this.props.onDecision(value);
        this.props.close();
    }

    onRetry() {
        this.decide("retry");
    }

    onPrinted() {
        this.decide("printed");
    }

    onDismiss() {
        this.decide("cancel");
    }
}

/**
 * Arma la funcion que el motor llama cuando hay una falla ambigua. `dialogService` es el servicio
 * de dialogos de Odoo; se pasa por parametro para poder probarlo sin pantalla.
 */
export function buildAmbiguousPrintHandler(dialogService) {
    return function askCashier(info = {}) {
        return new Promise((resolve) => {
            dialogService.add(
                BlQzPrintAlertDialog,
                {
                    jobName: info.jobName || "",
                    printerName: info.printerName || "",
                    attempt: info.attempt || 1,
                    onDecision: resolve,
                },
                { onClose: () => resolve("cancel") }
            );
        });
    };
}
