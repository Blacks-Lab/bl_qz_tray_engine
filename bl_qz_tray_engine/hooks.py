# -*- coding: utf-8 -*-

from psycopg2 import sql


# Formato: "columna": (tipo_sql, valor_default_python_o_None)
# El default se aplica con UPDATE ... WHERE col IS NULL porque el ALTER previo
# hace que el ORM saltee su propio relleno de defaults en _auto_init.
# Solo se rellenan defaults NO falsy: NULL ya se lee como False/0 en el ORM.
_SCHEMA_COLUMNS = {
    "pos_config": {
        "receipt_print_escpos": ("boolean", True),
        "qz_tray_printer_name": ("varchar", None),
        "qz_tray_force_raw": ("boolean", None),
        "qz_ticket_copies": ("integer", 1),
        "qz_logo_scale_percent": ("integer", 100),
        "qz_logo_dot_density": ("varchar", "double"),
        "qz_ticket_width_cols": ("integer", None),
        "qz_body_tuning_enabled": ("boolean", None),
        "qz_body_block_width": ("integer", 42),
        "qz_body_horizontal_offset": ("integer", None),
    },
}

_OLD_TO_NEW_PARAMS = {
    "l10n_ar_pos_einvoice_ticket.qz_signing_enabled": "bl_qz_tray.qz_signing_enabled",
    "l10n_ar_pos_einvoice_ticket.qz_signing_certificate_pem": "bl_qz_tray.qz_signing_certificate_pem",
    "l10n_ar_pos_einvoice_ticket.qz_signing_private_key_pem": "bl_qz_tray.qz_signing_private_key_pem",
}


def _get_cursor(env_or_cr):
    if hasattr(env_or_cr, "execute"):
        return env_or_cr
    if hasattr(env_or_cr, "cr") and hasattr(env_or_cr.cr, "execute"):
        return env_or_cr.cr
    raise TypeError("Hook argument must be an Environment or database cursor")


def ensure_schema_columns(cr):
    for table_name, columns in _SCHEMA_COLUMNS.items():
        for column_name, (column_type, default_value) in columns.items():
            cr.execute(
                sql.SQL("ALTER TABLE {} ADD COLUMN IF NOT EXISTS {} {}")
                .format(
                    sql.Identifier(table_name),
                    sql.Identifier(column_name),
                    sql.SQL(column_type),
                )
            )
            if default_value is None:
                continue
            cr.execute(
                sql.SQL("UPDATE {} SET {} = %s WHERE {} IS NULL")
                .format(
                    sql.Identifier(table_name),
                    sql.Identifier(column_name),
                    sql.Identifier(column_name),
                ),
                (default_value,),
            )


def migrate_signing_params(cr):
    for old_key, new_key in _OLD_TO_NEW_PARAMS.items():
        cr.execute(
            """
            INSERT INTO ir_config_parameter (key, value, create_uid, create_date, write_uid, write_date)
            SELECT %s, value, create_uid, create_date, write_uid, write_date
            FROM ir_config_parameter
            WHERE key = %s
              AND NOT EXISTS (
                  SELECT 1 FROM ir_config_parameter p2 WHERE p2.key = %s
              )
            """,
            (new_key, old_key, new_key),
        )


def pre_init_hook(env):
    ensure_schema_columns(_get_cursor(env))


def post_init_hook(env):
    cr = _get_cursor(env)
    ensure_schema_columns(cr)
    migrate_signing_params(cr)
