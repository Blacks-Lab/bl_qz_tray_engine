# -*- coding: utf-8 -*-

from odoo import SUPERUSER_ID, api


def migrate(cr, version):
    del version
    env = api.Environment(cr, SUPERUSER_ID, {})
    cr.execute(
        """
        UPDATE pos_config
           SET qz_image_encoding = 'esc_asterisk'
         WHERE qz_image_encoding IS NULL
        """
    )
    env["ir.attachment"].sudo().search(
        [("res_model", "=", "ir.ui.view"), ("name", "ilike", "assets")]
    ).unlink()
