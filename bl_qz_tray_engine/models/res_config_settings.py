# -*- coding: utf-8 -*-

from odoo import _, api, fields, models
from odoo.exceptions import UserError

from ..bl_qz_signing_utils import ensure_company_signing_material, has_company_signing_material


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    def _raise_qz_signing_dependency_error(self, error):
        raise UserError(_(
            "No se pudo completar la accion de firma QZ. "
            "Verifique que la libreria Python 'cryptography' este instalada en el servidor."
        )) from error

    pos_receipt_print_escpos = fields.Boolean(
        related="pos_config_id.receipt_print_escpos",
        string="Imprimir Ticket en ESC/POS (raw)",
        readonly=False,
    )
    pos_qz_tray_printer_name = fields.Char(
        related="pos_config_id.qz_tray_printer_name",
        string="Impresora QZ Tray",
        readonly=False,
    )
    pos_qz_tray_force_raw = fields.Boolean(
        related="pos_config_id.qz_tray_force_raw",
        string="QZ forceRaw",
        readonly=False,
    )
    pos_qz_logo_scale_percent = fields.Integer(
        related="pos_config_id.qz_logo_scale_percent",
        string="Escala de logo QZ (%)",
        readonly=False,
    )
    pos_qz_logo_dot_density = fields.Selection(
        related="pos_config_id.qz_logo_dot_density",
        string="Densidad logo QZ",
        readonly=False,
    )
    pos_qz_image_encoding = fields.Selection(
        related="pos_config_id.qz_image_encoding",
        string="Codificacion de imagen ESC/POS",
        readonly=False,
    )
    pos_qz_ticket_copies = fields.Integer(
        related="pos_config_id.qz_ticket_copies",
        string="Copias de ticket QZ",
        readonly=False,
    )
    pos_qz_ticket_width_cols = fields.Integer(
        related="pos_config_id.qz_ticket_width_cols",
        string="Ancho ticket QZ (columnas)",
        readonly=False,
    )
    pos_qz_body_tuning_enabled = fields.Boolean(
        related="pos_config_id.qz_body_tuning_enabled",
        string="Ajuste manual de bloque cuerpo",
        readonly=False,
    )
    pos_qz_body_block_width = fields.Integer(
        related="pos_config_id.qz_body_block_width",
        string="Ancho bloque cuerpo (columnas)",
        readonly=False,
    )
    pos_qz_body_horizontal_offset = fields.Integer(
        related="pos_config_id.qz_body_horizontal_offset",
        string="Offset horizontal bloque cuerpo",
        readonly=False,
    )

    qz_signing_enabled = fields.Boolean(
        related="company_id.bl_qz_signing_enabled",
        readonly=False,
        string="Firmar solicitudes de QZ automaticamente",
    )

    qz_signing_ready = fields.Boolean(
        string="Material de firma QZ generado",
        compute="_compute_qz_signing_ready",
    )

    @api.depends("qz_signing_enabled")
    def _compute_qz_signing_ready(self):
        for rec in self:
            rec.qz_signing_ready = has_company_signing_material(rec.company_id.sudo())

    def action_generate_qz_signing_material(self):
        self.ensure_one()
        params = self.env["ir.config_parameter"].sudo()
        base_url = params.get_param("web.base.url", "")
        try:
            ensure_company_signing_material(
                self.company_id.sudo(),
                force=True,
                base_url=base_url,
            )
        except RuntimeError as error:
            self._raise_qz_signing_dependency_error(error)

        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("QZ Tray"),
                "message": _(
                    "Se genero y guardo un nuevo certificado de firma para QZ. "
                    "Recargue la sesion de POS para aplicar los cambios."
                ),
                "type": "success",
                "sticky": False,
            },
        }

    def action_download_qz_signing_certificate(self):
        self.ensure_one()
        return {
            "type": "ir.actions.act_url",
            "url": f"/bl_qz/certificate/download?company_id={self.company_id.id}",
            "target": "new",
        }

    def action_print_qz_logo_header_test(self):
        raise UserError(_(
            "La prueba de logo/cabecera QZ esta disponible cuando instala el modulo "
            "l10n_ar_pos_einvoice_ticket sobre este engine."
        ))
