# -*- coding: utf-8 -*-
"""18.0.1.7.10: la escala del logo QZ queda dentro del rango que el modulo valida.

Las versiones viejas no validaban el campo y produccion tiene un TPV con 650 %. El POS ya
trata cualquier valor mayor a 300 como 300 al imprimir (bl_qz_logo.js), asi que el ticket sale
igual, pero la validacion nueva (50 a 300) rechazaria guardar ese TPV desde Ajustes. Se lleva el
valor al limite que ya se aplicaba en la practica. El 0 se deja: significa "usar el valor por
defecto" y el POS lo toma como 100.
"""


def migrate(cr, version):
    del version
    cr.execute(
        "UPDATE pos_config SET qz_logo_scale_percent = 300 WHERE qz_logo_scale_percent > 300"
    )
    cr.execute(
        "UPDATE pos_config SET qz_logo_scale_percent = 50 "
        "WHERE qz_logo_scale_percent > 0 AND qz_logo_scale_percent < 50"
    )
