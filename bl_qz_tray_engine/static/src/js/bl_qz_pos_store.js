/** @odoo-module */

import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/store/pos_store";
import { blQzGetDeviceUuid } from "./bl_qz_engine";

patch(PosStore.prototype, {
    async processServerData() {
        await super.processServerData(...arguments);
        await this.blQzLoadDevice();
    },

    async blQzLoadDevice() {
        const deviceUuid = blQzGetDeviceUuid();
        if (!deviceUuid || !this.data?.call) {
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

        this.bl_qz_device = device || null;
        if (this.config) {
            this.config.bl_qz_device = this.bl_qz_device;
        }
        return this.bl_qz_device;
    },
});
