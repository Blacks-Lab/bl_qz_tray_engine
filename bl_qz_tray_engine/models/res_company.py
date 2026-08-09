# -*- coding: utf-8 -*-

from odoo import fields, models


class ResCompany(models.Model):
    _inherit = "res.company"

    bl_qz_certificate_pem = fields.Text(string="Certificado QZ (PEM)")
    bl_qz_private_key_pem = fields.Text(
        string="Clave privada QZ (PEM)",
        groups="base.group_system",
    )
    bl_qz_signing_enabled = fields.Boolean(
        string="Firmar solicitudes de QZ",
        default=True,
    )
