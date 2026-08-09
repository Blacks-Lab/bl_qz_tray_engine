# -*- coding: utf-8 -*-

import logging

from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)


def _migrate_pos_fallback_printer(cr):
    cr.execute(
        """
        UPDATE pos_config
           SET bl_qz_fallback_printer_name = qz_tray_printer_name
         WHERE COALESCE(NULLIF(TRIM(bl_qz_fallback_printer_name), ''), '') = ''
           AND COALESCE(NULLIF(TRIM(qz_tray_printer_name), ''), '') <> ''
        """
    )


def _log_kitchen_legacy_printers(cr):
    cr.execute(
        """
        SELECT COUNT(*)
          FROM information_schema.columns
         WHERE table_name = 'pos_config'
           AND column_name IN ('bl_kitchen_qz_printer1', 'bl_kitchen_qz_printer2')
        """
    )
    if (cr.fetchone() or [0])[0] < 2:
        _logger.info("[bl_qz_tray_engine] No legacy kitchen printer columns found in pos_config.")
        return

    cr.execute(
        """
        SELECT id,
               COALESCE(name, '') AS name,
               COALESCE(TRIM(bl_kitchen_qz_printer1), '') AS printer1,
               COALESCE(TRIM(bl_kitchen_qz_printer2), '') AS printer2
          FROM pos_config
         WHERE COALESCE(TRIM(bl_kitchen_qz_printer1), '') <> ''
            OR COALESCE(TRIM(bl_kitchen_qz_printer2), '') <> ''
         ORDER BY id
        """
    )
    rows = cr.fetchall()
    if not rows:
        _logger.info("[bl_qz_tray_engine] No legacy kitchen printers configured in pos_config.")
        return

    _logger.info(
        "[bl_qz_tray_engine] Legacy kitchen printers snapshot (for manual recreation in device panel):"
    )
    for config_id, config_name, printer1, printer2 in rows:
        _logger.info(
            "[bl_qz_tray_engine] POS id=%s name=%s printer1=%s printer2=%s",
            config_id,
            config_name,
            printer1 or "-",
            printer2 or "-",
        )


def _purge_assets(env):
    env["ir.attachment"].sudo().search(
        [("res_model", "=", "ir.ui.view"), ("name", "ilike", "assets")]
    ).unlink()


def migrate(cr, version):
    del version
    env = api.Environment(cr, SUPERUSER_ID, {})

    _migrate_pos_fallback_printer(cr)
    _log_kitchen_legacy_printers(cr)
    _purge_assets(env)
