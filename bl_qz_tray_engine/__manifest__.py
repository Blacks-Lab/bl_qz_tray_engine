# -*- coding: utf-8 -*-
{
    "name": "BlackLabs QZ Tray Engine",
    "version": "18.0.1.0.9",
    "author": "Ernesto Bernís - BlackLabs",
    "license": "LGPL-3",
    "category": "Point Of Sale",
    "website": "https://github.com/Blacks-Lab",
    "summary": "Motor generico de impresion QZ Tray para modulos BlackLabs en Odoo 18 CE.",
    "depends": ["point_of_sale"],
    "external_dependencies": {"python": ["cryptography"]},
    "data": [
        "views/bl_qz_res_config_settings_views.xml",
        "views/bl_qz_pos_config_views.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "/bl_qz_tray_engine/static/src/js/bl_qz_security.js",
            "/bl_qz_tray_engine/static/src/js/bl_qz_backend_printer_selector.js",
            "/bl_qz_tray_engine/static/src/js/bl_qz_logo.js",
        ],
        "point_of_sale._assets_pos": [
            "/bl_qz_tray_engine/static/src/js/bl_qz_security.js",
            "/bl_qz_tray_engine/static/src/js/bl_qz_settings.js",
            "/bl_qz_tray_engine/static/src/js/bl_qz_logo.js",
            "/bl_qz_tray_engine/static/src/js/bl_qz_engine.js",
        ],
    },
    "pre_init_hook": "pre_init_hook",
    "post_init_hook": "post_init_hook",
    "installable": True,
    "auto_install": False,
}
