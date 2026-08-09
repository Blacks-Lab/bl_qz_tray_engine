# -*- coding: utf-8 -*-

import uuid

from odoo import _, api, fields, models
from odoo.exceptions import UserError

from ..bl_qz_signing_utils import ensure_company_signing_material


class BlQzDevice(models.Model):
    _name = "bl.qz.device"
    _description = "Equipo con QZ Tray"
    _inherit = ["mail.thread"]
    _order = "name"

    name = fields.Char(required=True, tracking=True)
    device_uuid = fields.Char(
        required=True,
        index=True,
        copy=False,
        readonly=True,
        default=lambda self: str(uuid.uuid4()),
    )
    company_id = fields.Many2one(
        "res.company",
        required=True,
        default=lambda self: self.env.company,
        index=True,
    )
    qz_enabled = fields.Boolean(
        default=True,
        tracking=True,
        string="Usar impresion ESC/POS via QZ Tray",
    )
    printer_mode = fields.Selection(
        [
            ("global", "Una impresora para todos los modulos"),
            ("per_module", "Impresora propia por modulo"),
        ],
        default="global",
        required=True,
        tracking=True,
    )
    printer_name = fields.Char(string="Impresora del equipo", tracking=True)
    copies = fields.Integer(default=1, string="Copias")
    force_raw = fields.Boolean(default=False, string="Force RAW")
    printer_ids = fields.One2many("bl.qz.device.printer", "device_id")
    last_seen = fields.Datetime(readonly=True)
    active = fields.Boolean(default=True)

    _sql_constraints = [
        (
            "device_uuid_uniq",
            "unique(device_uuid)",
            "Ya existe un equipo con ese identificador.",
        ),
    ]

    @api.model
    def _bl_qz_default_module_rows(self):
        return [
            ("fiscal", 10),
            ("retiro", 20),
            ("comanda", 30),
            ("mozo", 40),
        ]

    @api.model
    def bl_qz_resolve_device(self, device_uuid, default_name=None):
        """Devuelve el dict del equipo para ese uuid. Lo crea si no existe.

        Actualiza last_seen. Es el unico punto de entrada desde el POS.
        """
        resolved_uuid = (device_uuid or "").strip()
        if not resolved_uuid:
            return False

        device = self.search([("device_uuid", "=", resolved_uuid)], limit=1)
        if not device:
            fallback_name = (default_name or "").strip() or f"Equipo {resolved_uuid[:8]}"
            device = self.create(
                {
                    "device_uuid": resolved_uuid,
                    "name": fallback_name,
                    "company_id": self.env.company.id,
                }
            )

        existing_module_keys = {row.module_key for row in device.printer_ids}
        create_commands = []
        for module_key, sequence in self._bl_qz_default_module_rows():
            if module_key in existing_module_keys:
                continue
            create_commands.append(
                (
                    0,
                    0,
                    {
                        "module_key": module_key,
                        "printer_name": "",
                        "copies": 1,
                        "force_raw": False,
                        "sequence": sequence,
                    },
                )
            )
        if create_commands:
            device.write({"printer_ids": create_commands})

        device.write({"last_seen": fields.Datetime.now()})
        printer_rows = device.printer_ids.sorted(lambda row: (row.sequence, row.id))
        return {
            "id": device.id,
            "device_uuid": device.device_uuid,
            "name": device.name,
            "qz_enabled": bool(device.qz_enabled),
            "printer_mode": device.printer_mode,
            "printer_name": device.printer_name,
            "copies": device.copies,
            "force_raw": bool(device.force_raw),
            "company_id": device.company_id.id,
            "can_download_certificate": self.env.user.has_group("point_of_sale.group_pos_manager"),
            "can_generate_certificate": self.env.user.has_group("base.group_system"),
            "printer_ids": [
                {
                    "module_key": row.module_key,
                    "printer_name": row.printer_name,
                    "copies": row.copies,
                    "force_raw": bool(row.force_raw),
                    "sequence": row.sequence,
                }
                for row in printer_rows
            ],
        }

    def _resolve_header_test_printer(self, pos_config):
        self.ensure_one()
        if not self.qz_enabled:
            raise UserError(_(
                "El equipo tiene desactivada la impresion QZ. Active QZ para ejecutar la prueba."
            ))

        printer_name = ""
        copies = max(1, int(self.copies or 1))
        force_raw = bool(self.force_raw)

        if self.printer_mode == "per_module":
            row = self.printer_ids.filtered(lambda rec: rec.module_key == "fiscal")[:1]
            if not row:
                row = self.printer_ids[:1]
            if row and row.printer_name:
                printer_name = row.printer_name
                copies = max(1, int(row.copies or 1))
                force_raw = bool(row.force_raw)

        if not printer_name:
            printer_name = (self.printer_name or "").strip()

        if not printer_name and pos_config:
            printer_name = (pos_config.bl_qz_fallback_printer_name or "").strip()

        if not printer_name:
            raise UserError(_(
                "No hay impresora configurada para este equipo. Defina una impresora global o por modulo."
            ))

        return printer_name, copies, force_raw

    def action_print_qz_logo_header_test(self):
        self.ensure_one()

        installed = self.env["ir.module.module"].sudo().search_count(
            [
                ("name", "=", "l10n_ar_pos_einvoice_ticket"),
                ("state", "=", "installed"),
            ]
        )
        if not installed:
            raise UserError(_(
                "La prueba de logo/cabecera QZ esta disponible cuando instala el modulo "
                "l10n_ar_pos_einvoice_ticket sobre este engine."
            ))

        pos_config = self.env["pos.config"].search(
            [("company_id", "=", self.company_id.id)],
            limit=1,
        )
        if not pos_config:
            raise UserError(_(
                "No se encontro una configuracion de POS para la compania del equipo."
            ))

        printer_name, copies, force_raw = self._resolve_header_test_printer(pos_config)

        company = self.company_id.sudo()
        company_parent = company.parent_id.sudo()
        company_name = company_parent.name or company.name or ""
        company_vat = company_parent.vat or company.vat or ""
        company_gross_income = (
            company_parent.l10n_ar_gross_income_number
            or company.l10n_ar_gross_income_number
            or ""
        )
        company_start_date = (
            company_parent.l10n_ar_afip_start_date
            or company.l10n_ar_afip_start_date
            or ""
        )
        if company_start_date:
            company_start_date_str = company_start_date.strftime("%d/%m/%Y")
        else:
            company_start_date_str = ""

        address_parts = [
            company.street or "",
            company.city or "",
            company.state_id.name if company.state_id else "",
            company.country_id.name if company.country_id else "",
        ]
        company_address = ", ".join([part for part in address_parts if part])

        return {
            "type": "ir.actions.client",
            "tag": "l10n_ar_pos_einvoice_ticket_qz_logo_header_test",
            "params": {
                "config": {
                    "receipt_print_escpos": bool(pos_config.receipt_print_escpos),
                    "qz_tray_printer_name": printer_name,
                    "qz_tray_force_raw": force_raw,
                    "logo_width": int(pos_config.logo_width or 150),
                    "logo_height": int(pos_config.logo_height or 80),
                    "logo_keep_aspect_ratio": bool(pos_config.logo_keep_aspect_ratio),
                    "logo_alignment": pos_config.logo_alignment or "center",
                    "qz_logo_scale_percent": int(pos_config.qz_logo_scale_percent or 130),
                    "qz_logo_dot_density": pos_config.qz_logo_dot_density or "double",
                    "qz_ticket_copies": copies,
                },
                "company": {
                    "id": company.id,
                    "name": company_name,
                    "vat": company_vat,
                    "gross_income": company_gross_income,
                    "start_date": company_start_date_str,
                    "address": company_address,
                    "email": company.email or "",
                    "phone": company.phone or "",
                },
            },
        }

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
            raise UserError(_(
                "No se pudo completar la accion de firma QZ. "
                "Verifique que la libreria Python 'cryptography' este instalada en el servidor."
            )) from error

        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("QZ Tray"),
                "message": _(
                    "Se genero y guardo un nuevo certificado de firma para la compania del equipo."
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


class BlQzDevicePrinter(models.Model):
    _name = "bl.qz.device.printer"
    _description = "Impresora por modulo de un equipo"
    _order = "device_id, sequence, id"

    device_id = fields.Many2one(
        "bl.qz.device",
        required=True,
        ondelete="cascade",
        index=True,
    )
    module_key = fields.Selection(selection="_bl_qz_module_keys", required=True)
    printer_name = fields.Char()
    copies = fields.Integer(default=1)
    force_raw = fields.Boolean(default=False)
    sequence = fields.Integer(default=10)
    company_id = fields.Many2one(
        related="device_id.company_id",
        store=True,
        index=True,
    )

    _sql_constraints = [
        (
            "device_module_uniq",
            "unique(device_id, module_key)",
            "Cada modulo puede tener una sola fila por equipo.",
        ),
    ]

    @api.model
    def _bl_qz_module_keys(self):
        return [
            ("fiscal", "fiscal"),
            ("retiro", "retiro"),
            ("comanda", "comanda"),
            ("mozo", "mozo"),
        ]
