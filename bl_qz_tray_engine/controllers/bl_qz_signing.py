# -*- coding: utf-8 -*-

import base64

from odoo import _, http
from odoo.exceptions import UserError
from odoo.http import request

from ..bl_qz_signing_utils import (
    QZ_PARAM_SIGNING_ENABLED,
    QZ_SIGNATURE_ALGORITHM,
    ensure_signing_material,
    normalize_pem,
    param_is_enabled,
)


class BlQzSigningController(http.Controller):

    @staticmethod
    def _get_cryptography_primitives():
        try:
            from cryptography.hazmat.primitives import hashes
            from cryptography.hazmat.primitives.asymmetric import padding
            from cryptography.hazmat.primitives.serialization import load_pem_private_key
        except Exception as error:
            raise UserError(_(
                "La dependencia Python 'cryptography' no esta disponible en el servidor. "
                "Instalela para habilitar firma de QZ Tray."
            )) from error

        return hashes, padding, load_pem_private_key

    @staticmethod
    def _hash_algorithm():
        hashes, _, _ = BlQzSigningController._get_cryptography_primitives()
        if QZ_SIGNATURE_ALGORITHM == "SHA512":
            return hashes.SHA512()
        if QZ_SIGNATURE_ALGORITHM == "SHA1":
            return hashes.SHA1()
        return hashes.SHA256()

    @staticmethod
    def _build_config_error():
        return UserError(_(
            "No se pudo configurar la firma de QZ Tray. "
            "Revise la configuracion en Punto de Venta > Ajustes."
        ))

    @staticmethod
    def _get_certificate_pem():
        params = request.env["ir.config_parameter"].sudo()
        try:
            certificate, private_key = ensure_signing_material(params)
        except RuntimeError as error:
            raise UserError(_(
                "No se puede generar el certificado de QZ Tray porque falta la dependencia "
                "Python 'cryptography'."
            )) from error
        del private_key

        certificate = normalize_pem(certificate)
        if not certificate:
            raise UserError(_(
                "No se encontro un certificado valido para QZ Tray. "
                "Genere uno nuevo desde Ajustes de Punto de Venta."
            ))

        return certificate

    def _get_private_key_pem(self):
        params = request.env["ir.config_parameter"].sudo()

        enabled = param_is_enabled(params.get_param(QZ_PARAM_SIGNING_ENABLED, "True"))
        if not enabled:
            raise UserError(_(
                "La firma de QZ Tray esta desactivada. "
                "Active la opcion de firma en Ajustes de Punto de Venta."
            ))

        try:
            cert, private_key = ensure_signing_material(params)
        except RuntimeError as error:
            raise UserError(_(
                "No se puede generar la clave de firma de QZ Tray porque falta la dependencia "
                "Python 'cryptography'."
            )) from error
        del cert

        private_key = normalize_pem(private_key)
        if not private_key:
            raise self._build_config_error()

        return private_key

    @http.route(
        "/bl_qz/certificate",
        type="json",
        auth="user",
    )
    def qz_certificate(self):
        params = request.env["ir.config_parameter"].sudo()

        enabled = param_is_enabled(params.get_param(QZ_PARAM_SIGNING_ENABLED, "True"))
        if not enabled:
            raise UserError(_(
                "La firma de QZ Tray esta desactivada. "
                "Active la opcion de firma en Ajustes de Punto de Venta."
            ))

        certificate = self._get_certificate_pem()

        return {
            "certificate": certificate,
            "algorithm": QZ_SIGNATURE_ALGORITHM,
        }

    @http.route(
        "/bl_qz/certificate/download",
        type="http",
        auth="user",
    )
    def qz_certificate_download(self):
        certificate = self._get_certificate_pem()
        headers = [
            ("Content-Type", "application/x-pem-file; charset=utf-8"),
            ("Content-Disposition", 'attachment; filename="qz-tray-certificate.pem"'),
        ]
        return request.make_response(certificate, headers=headers)

    @http.route(
        "/bl_qz/sign",
        type="json",
        auth="user",
    )
    def qz_sign(self, data_to_sign=None):
        if not data_to_sign or not isinstance(data_to_sign, str):
            raise UserError(_("No hay contenido para firmar en la solicitud QZ."))

        private_key_pem = self._get_private_key_pem()
        _, padding, load_pem_private_key = self._get_cryptography_primitives()

        try:
            private_key = load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
        except Exception as error:
            raise UserError(_(
                "La clave privada configurada para QZ Tray es invalida. "
                "Genere un nuevo certificado desde Ajustes."
            )) from error

        signature_raw = private_key.sign(
            data_to_sign.encode("utf-8"),
            padding.PKCS1v15(),
            self._hash_algorithm(),
        )

        return {
            "signature": base64.b64encode(signature_raw).decode("ascii"),
            "algorithm": QZ_SIGNATURE_ALGORITHM,
        }
