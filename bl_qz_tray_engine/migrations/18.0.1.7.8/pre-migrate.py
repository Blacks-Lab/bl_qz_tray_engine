# -*- coding: utf-8 -*-
"""18.0.1.7.8: el panel de dispositivos se muda del formulario del Punto de Venta a Ajustes.

l10n_ar_pos_einvoice_ticket tenia una vista heredada que apuntaba al nodo
//setting[@id='bl_qz_device_panel_pos_config'] (con invisible="0", o sea que no hacia nada).
Ese nodo ya no existe. Odoo revalida todas las vistas que heredan de la del motor cuando esta
cambia, y la vieja de l10n recien se borra al final de la actualizacion de l10n: si no se
borra antes, la actualizacion falla sin importar el orden de los modulos.
"""


def migrate(cr, version):
    del version
    cr.execute(
        """
        SELECT res_id
          FROM ir_model_data
         WHERE module = 'l10n_ar_pos_einvoice_ticket'
           AND name = 'pos_config_view_form_hide_qz_engine_setting'
           AND model = 'ir.ui.view'
        """
    )
    view_ids = [row[0] for row in cr.fetchall()]
    if not view_ids:
        return
    cr.execute("DELETE FROM ir_ui_view WHERE id = ANY(%s)", (view_ids,))
    cr.execute(
        """
        DELETE FROM ir_model_data
         WHERE module = 'l10n_ar_pos_einvoice_ticket'
           AND name = 'pos_config_view_form_hide_qz_engine_setting'
           AND model = 'ir.ui.view'
        """
    )
