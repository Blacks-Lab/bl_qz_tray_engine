/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/store/pos_store";
import { blQzGetDeviceUuid, blQzSetAmbiguousPrintHandler } from "./bl_qz_engine";
import { buildAmbiguousPrintHandler } from "./bl_qz_print_alert";

// Espera antes de volver a leer la configuracion al volver a esta pestana: da tiempo a que
// termine de guardarse lo que se cambio en la otra pestana (Ajustes).
const BL_QZ_REFRESH_DELAY_MS = 700;
const BL_QZ_REFRESH_MIN_INTERVAL_MS = 2000;

patch(PosStore.prototype, {
    async processServerData() {
        await super.processServerData(...arguments);
        // Aviso con el estilo de la seccion cuando se corta la comunicacion con la impresora.
        if (this.dialog?.add) {
            blQzSetAmbiguousPrintHandler(buildAmbiguousPrintHandler(this.dialog));
        }
        await this.blQzLoadDevice();
        this.blQzWatchDeviceChanges();
    },

    /**
     * Cuando se vuelve a la pestana del POS (por ejemplo despues de cambiar la configuracion de
     * QZ Tray Engine en otra pestana) se vuelve a leer la configuracion de esta computadora, asi
     * no hace falta actualizar el navegador. Todos los modulos leen config.bl_qz_device, por eso
     * alcanza con renovar ese dato.
     */
    blQzWatchDeviceChanges() {
        if (this._blQzWatching || typeof document === "undefined") {
            return;
        }
        this._blQzWatching = true;
        let timer = null;
        const refresh = () => {
            if (document.visibilityState === "hidden") {
                return;
            }
            if (timer) {
                clearTimeout(timer);
            }
            timer = setTimeout(async () => {
                timer = null;
                const now = Date.now();
                if (
                    this._blQzRefreshing ||
                    now - (this._blQzLastRefresh || 0) < BL_QZ_REFRESH_MIN_INTERVAL_MS
                ) {
                    return;
                }
                this._blQzRefreshing = true;
                this._blQzLastRefresh = now;
                try {
                    await this.blQzLoadDevice({ keepOnError: true });
                } finally {
                    this._blQzRefreshing = false;
                }
            }, BL_QZ_REFRESH_DELAY_MS);
        };
        document.addEventListener("visibilitychange", refresh);
        window.addEventListener("focus", refresh);
    },

    async blQzLoadDevice({ keepOnError = false } = {}) {
        const deviceUuid = blQzGetDeviceUuid();
        if (!deviceUuid || !this.data?.call) {
            if (keepOnError && this.bl_qz_device) {
                return this.bl_qz_device;
            }
            this.bl_qz_device = null;
            if (this.config) {
                this.config.bl_qz_device = null;
            }
            return null;
        }

        const defaultName = `Equipo ${deviceUuid.slice(0, 8)}`;
        let device = null;
        try {
            device = await this.data.call("bl.qz.device", "bl_qz_resolve_device", [
                deviceUuid,
                defaultName,
            ]);
        } catch (error) {
            console.warn("[bl_qz_tray_engine] No se pudo resolver bl.qz.device:", error);
            device = null;
        }

        // Al refrescar, si el servidor no responde se conserva lo ya cargado.
        if (keepOnError && !device && this.bl_qz_device) {
            return this.bl_qz_device;
        }

        this.bl_qz_device = device || null;
        if (this.config) {
            this.config.bl_qz_device = this.bl_qz_device;
        }
        return this.bl_qz_device;
    },
});
