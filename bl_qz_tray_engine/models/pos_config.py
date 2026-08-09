# -*- coding: utf-8 -*-

from odoo import api, fields, models


class PosConfig(models.Model):
    _inherit = "pos.config"

    bl_qz_fallback_printer_name = fields.Char(
        string="Impresora por defecto del TPV",
        help=(
            "Se usa solo si el equipo desde el que se opera no tiene impresora propia "
            "configurada."
        ),
    )

    receipt_print_escpos = fields.Boolean("Imprimir via QZ Tray (ESC/POS)", default=True)
    qz_tray_printer_name = fields.Char(
        "Nombre impresora QZ",
        default="",
        help=(
            "Campo legacy (deprecado). Se mantiene por compatibilidad con modulos existentes. "
            "Use la configuracion por dispositivo o la impresora por defecto del TPV."
        ),
    )
    qz_tray_force_raw = fields.Boolean(
        "Force Raw",
        default=False,
        help=(
            "Campo legacy (deprecado). Se mantiene por compatibilidad con modulos existentes. "
            "Use la configuracion por dispositivo para nuevos desarrollos."
        ),
    )
    qz_ticket_copies = fields.Integer("Copias por ticket", default=1)
    qz_logo_scale_percent = fields.Integer("Escala logo QZ (%)", default=100)
    qz_logo_dot_density = fields.Selection(
        [("single", "Single"), ("double", "Double")],
        string="Densidad logo",
        default="double",
    )
    qz_image_encoding = fields.Selection(
        [
            ("esc_asterisk", "ESC * (maxima compatibilidad)"),
            ("raster", "GS v 0 (mas rapido)"),
        ],
        string="Codificacion de imagen ESC/POS",
        default="esc_asterisk",
        help=(
            "ESC *: envia el raster en bandas de 24 filas. Compatible con casi todo "
            "el firmware pero mas lento.\n"
            "GS v 0: envia la imagen completa en un solo comando. Mas rapido y "
            "visualmente identico, pero requiere firmware compatible. Si el ticket "
            "sale con caracteres basura, volve a ESC *."
        ),
    )
    qz_ticket_width_cols = fields.Integer("Ancho ticket (cols)", default=0)
    qz_body_tuning_enabled = fields.Boolean("Ajuste manual cuerpo", default=False)
    qz_body_block_width = fields.Integer("Ancho bloque cuerpo", default=42)
    qz_body_horizontal_offset = fields.Integer("Offset horizontal", default=0)

    @api.model
    def _load_pos_data_fields(self, config_id):
        fields_list = super()._load_pos_data_fields(config_id)
        if not fields_list:
            return fields_list
        qz_fields = [
            "bl_qz_fallback_printer_name",
            "receipt_print_escpos",
            "qz_tray_printer_name",
            "qz_tray_force_raw",
            "qz_ticket_copies",
            "qz_logo_scale_percent",
            "qz_logo_dot_density",
            "qz_image_encoding",
            "qz_ticket_width_cols",
            "qz_body_tuning_enabled",
            "qz_body_block_width",
            "qz_body_horizontal_offset",
        ]
        for field_name in qz_fields:
            if field_name not in fields_list:
                fields_list.append(field_name)
        return fields_list

    def bl_get_qz_header_print_config(self):
        """Return live header/logo printing config used by QZ flows.

        Frontend POS callers should use this helper instead of raw `read` so the
        same subset is reused across modules and ACL edge-cases are minimized.
        """
        self.ensure_one()

        candidate_fields = [
            "receipt_print_escpos",
            "qz_tray_pixel_direct",
            "logo_width",
            "logo_height",
            "logo_keep_aspect_ratio",
            "logo_alignment",
            "qz_logo_scale_percent",
            "qz_logo_dot_density",
            "qz_image_encoding",
            "qz_ticket_copies",
            "qz_tray_force_raw",
            "qz_tray_printer_name",
            "receipt_header_type",
            "bl_budget_show_order_number",
            "bl_budget_show_company_name",
            "bl_budget_company_name_text",
            "bl_budget_show_header_details",
            "bl_show_ticket_discount_summary",
            "bl_enable_gift_receipt",
            "bl_gift_receipt_slogan",
            "bl_invoice_receipt_slogan",
            "bl_kitchen_ticket_header",
        ]
        fields_to_read = [field_name for field_name in candidate_fields if field_name in self._fields]
        if not fields_to_read:
            return {}

        values = self.sudo().read(fields_to_read)[0]
        values.pop("id", None)
        return values
