# -*- coding: utf-8 -*-
"""18.0.1.7.15: borra la copia vieja de la clave privada de firma en los parametros del sistema.

Decision de BlackStar (2026-11-12). La firma real usa la clave de la compania (campo que solo lee
el administrador); la copia en `ir_config_parameter` quedaba en texto plano, visible para quien
mire parametros y dentro de todos los respaldos, y ningun codigo la lee.

Solo se borra si la compania YA tiene exactamente esa misma clave: si no coincide, se deja como
esta y se avisa en el registro, para no perder nunca la unica copia.
"""
import logging

_logger = logging.getLogger(__name__)

_KEYS = (
    "bl_qz_tray.qz_signing_private_key_pem",
    "l10n_ar_pos_einvoice_ticket.qz_signing_private_key_pem",
)


def _norm(text):
    return (text or "").replace("\r\n", "\n").strip()


def migrate(cr, version):
    del version
    cr.execute("SELECT bl_qz_private_key_pem FROM res_company WHERE bl_qz_private_key_pem IS NOT NULL")
    company_keys = {_norm(row[0]) for row in cr.fetchall()} - {""}
    cr.execute("SELECT id, key, value FROM ir_config_parameter WHERE key IN %s", (_KEYS,))
    for param_id, key, value in cr.fetchall():
        if _norm(value) in company_keys:
            cr.execute("DELETE FROM ir_config_parameter WHERE id = %s", (param_id,))
            _logger.info("bl_qz_tray_engine: se borro la copia vieja de la clave privada (%s)", key)
        else:
            _logger.warning(
                "bl_qz_tray_engine: el parametro %s no coincide con la clave de ninguna compania; "
                "no se borra para no perder la unica copia.", key
            )
