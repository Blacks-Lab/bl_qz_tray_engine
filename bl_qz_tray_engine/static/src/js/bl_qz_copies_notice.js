/** @odoo-module **/

import { Component, onMounted, onPatched, onWillStart, onWillUnmount, useRef, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardWidgetProps } from "@web/views/widgets/standard_widget_props";

const DEVICE_UUID_KEY = "bl_qz_device_uuid";
// Consulta en curso, compartida por todos los avisos de copias abiertos a la vez (se borra al terminar,
// asi una lectura posterior siempre trae el dato nuevo).
let sharedLoad = null;

/**
 * Aviso que va debajo del campo de copias de un modulo (por ejemplo "Copias del comprobante").
 * Si ESTA computadora tiene encendido "Misma cantidad de copias para todos los comprobantes"
 * en QZ Tray Engine, apaga el campo del modulo y dice donde se define. Si no, no hace nada.
 *
 * El campo del modulo se envuelve asi en la vista:
 *   <div class="bl-copies-field">
 *       <div class="bl-copies-input"> ...label y field... </div>
 *       <widget name="bl_qz_copies_notice"/>
 *   </div>
 */
export class BlQzCopiesNotice extends Component {
    static template = "bl_qz_tray_engine.BlQzCopiesNotice";
    static props = { ...standardWidgetProps };

    setup() {
        this.orm = useService("orm");
        this.root = useRef("root");
        this.state = useState({ locked: false, copies: 1 });

        onWillStart(async () => {
            await this._load();
        });
        onMounted(() => this._applyLock());
        onPatched(() => this._applyLock());

        // El bloqueo se calculaba una sola vez al abrir el formulario: si el interruptor
        // cambiaba en otra pestania el campo quedaba mal hasta recargar (H26). Ahora se
        // vuelve a leer cuando la pestania recupera el foco.
        this._reloadOnReturn = () => {
            if (!document.hidden) {
                this._load();
            }
        };
        onMounted(() => {
            document.addEventListener("visibilitychange", this._reloadOnReturn);
            window.addEventListener("focus", this._reloadOnReturn);
        });
        onWillUnmount(() => {
            document.removeEventListener("visibilitychange", this._reloadOnReturn);
            window.removeEventListener("focus", this._reloadOnReturn);
        });
    }

    async _load() {
        let uuid = "";
        try {
            uuid = (window.localStorage.getItem(DEVICE_UUID_KEY) || "").trim();
        } catch {
            uuid = "";
        }
        if (!uuid) {
            return;
        }
        try {
            // Hay un aviso por cada modulo y todos se actualizan juntos al volver a la pestania:
            // comparten UNA sola consulta (cada una escribe last_seen en el servidor).
            if (!sharedLoad || sharedLoad.uuid !== uuid) {
                const promise = this.orm.call("bl.qz.device", "bl_qz_resolve_device", [
                    uuid,
                    `Equipo ${uuid.slice(0, 8)}`,
                ]);
                const entry = { uuid, promise };
                sharedLoad = entry;
                const clear = () => {
                    if (sharedLoad === entry) {
                        sharedLoad = null;
                    }
                };
                promise.then(clear, clear);
            }
            const device = await sharedLoad.promise;
            this.state.locked = Boolean(
                device &&
                    device.qz_enabled !== false &&
                    device.printer_mode !== "per_module" &&
                    device.copies_all
            );
            this.state.copies = Math.max(1, Number.parseInt(device?.copies, 10) || 1);
        } catch {
            this.state.locked = false;
        }
    }

    _applyLock() {
        const wrap = this.root.el?.closest(".bl-copies-field");
        const input = wrap?.querySelector(".bl-copies-input");
        if (!input) {
            return;
        }
        input.toggleAttribute("inert", this.state.locked);
        input.classList.toggle("bl-locked", this.state.locked);
    }
}

registry.category("view_widgets").add("bl_qz_copies_notice", {
    component: BlQzCopiesNotice,
});
