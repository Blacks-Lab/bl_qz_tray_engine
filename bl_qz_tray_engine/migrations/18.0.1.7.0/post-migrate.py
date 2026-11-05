# -*- coding: utf-8 -*-


def migrate(cr, version):
    """El equipo deja de pertenecer a una compania.

    bl.qz.device tenia la visibilidad acotada por compania (ir.rule) y la unicidad global
    (unique(device_uuid)). Las dos cosas juntas rompen en cuanto una misma PC opera mas de
    una compania: el registro queda invisible, el modulo intenta crearlo y el indice lo
    rechaza. Vaciar company_id lo hace visible desde todas las companias, que es lo que la
    propia regla ya contempla con ('company_id', '=', False).

    bl_qz_device_printer.company_id es un related store=True de device_id.company_id, asi que
    se vacia en la misma pasada.
    """
    cr.execute("UPDATE bl_qz_device SET company_id = NULL WHERE company_id IS NOT NULL")
    cr.execute(
        "UPDATE bl_qz_device_printer SET company_id = NULL WHERE company_id IS NOT NULL"
    )
    # Por el ORM (borra tambien el archivo del filestore) y sin distinguir mayusculas, igual
    # que las migraciones 1.5.0 y 1.6.4 (H18).
    from odoo import SUPERUSER_ID, api

    env = api.Environment(cr, SUPERUSER_ID, {})
    env["ir.attachment"].search(
        [("res_model", "=", "ir.ui.view"), ("name", "ilike", "assets")]
    ).unlink()
