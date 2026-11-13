# -*- coding: utf-8 -*-
"""18.0.1.7.15: borra la copia vieja de la clave privada de firma en los parametros del sistema.

Decision de BlackStar (2026-11-12: "borra la vieja"). La firma real usa la clave de la compania
(campo que solo lee el administrador); la copia en `ir_config_parameter` quedaba en texto plano,
visible para quien mire parametros y dentro de todos los respaldos, y ningun codigo la lee. En
Che Pizza ni siquiera coincide con la clave que firma hoy: es una clave vieja.

Solo se borra si al menos una compania YA tiene su propia clave; si ninguna la tiene se deja,
para no perder nunca la unica copia (la migracion 1.5.0 pasa esa copia a la compania antes).
"""
import logging

_logger = logging.getLogger(__name__)

_KEYS = (
    "bl_qz_tray.qz_signing_private_key_pem",
    "l10n_ar_pos_einvoice_ticket.qz_signing_private_key_pem",
)


def migrate(cr, version):
    del version
    cr.execute(
        "SELECT count(*) FROM res_company WHERE COALESCE(trim(bl_qz_private_key_pem), '') <> ''"
    )
    if not cr.fetchone()[0]:
        _logger.warning(
            "bl_qz_tray_engine: ninguna compania tiene clave propia; no se borra la copia de "
            "los parametros para no perder la unica."
        )
        return
    cr.execute("DELETE FROM ir_config_parameter WHERE key IN %s", (_KEYS,))
    _logger.info("bl_qz_tray_engine: se borro la copia vieja de la clave privada (%s filas)", cr.rowcount)
