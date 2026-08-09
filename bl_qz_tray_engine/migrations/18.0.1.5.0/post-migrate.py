# -*- coding: utf-8 -*-

from odoo import SUPERUSER_ID, api


def _normalize_pem(value):
    if not value:
        return ""
    lines = [line.strip() for line in str(value).replace("\r", "").split("\n") if line.strip()]
    if not lines:
        return ""
    return "\n".join(lines) + "\n"


def _param_is_enabled(raw_value):
    value = str(raw_value or "True").strip().lower()
    return value in {"1", "true", "yes", "on"}


def _migrate_pos_fallback_printer(cr):
    cr.execute(
        """
        UPDATE pos_config
           SET bl_qz_fallback_printer_name = qz_tray_printer_name
         WHERE COALESCE(NULLIF(TRIM(bl_qz_fallback_printer_name), ''), '') = ''
           AND COALESCE(NULLIF(TRIM(qz_tray_printer_name), ''), '') <> ''
        """
    )


def _migrate_signing_material_to_first_company(env):
    company = env["res.company"].sudo().search([], order="id ASC", limit=1)
    if not company:
        return

    params = env["ir.config_parameter"].sudo()
    cert = _normalize_pem(params.get_param("bl_qz_tray.qz_signing_certificate_pem", ""))
    key = _normalize_pem(params.get_param("bl_qz_tray.qz_signing_private_key_pem", ""))
    enabled = _param_is_enabled(params.get_param("bl_qz_tray.qz_signing_enabled", "True"))

    values = {
        "bl_qz_signing_enabled": enabled,
    }
    if cert and not _normalize_pem(company.bl_qz_certificate_pem):
        values["bl_qz_certificate_pem"] = cert
    if key and not _normalize_pem(company.bl_qz_private_key_pem):
        values["bl_qz_private_key_pem"] = key

    company.write(values)


def _purge_assets(env):
    env["ir.attachment"].sudo().search(
        [("res_model", "=", "ir.ui.view"), ("name", "ilike", "assets")]
    ).unlink()


def migrate(cr, version):
    del version
    env = api.Environment(cr, SUPERUSER_ID, {})

    _migrate_pos_fallback_printer(cr)
    _migrate_signing_material_to_first_company(env)
    _purge_assets(env)
