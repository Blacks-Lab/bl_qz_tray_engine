# -*- coding: utf-8 -*-

from odoo.addons.bl_qz_tray_engine.hooks import ensure_schema_columns

def migrate(cr, version):
    del version
    ensure_schema_columns(cr)
