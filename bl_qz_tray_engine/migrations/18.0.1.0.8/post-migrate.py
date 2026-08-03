# -*- coding: utf-8 -*-

from odoo import SUPERUSER_ID, api


def migrate(cr, version):
    del version
    env = api.Environment(cr, SUPERUSER_ID, {})
    env["ir.attachment"].sudo().search(
        [("res_model", "=", "ir.ui.view"), ("name", "ilike", "assets")]
    ).unlink()
