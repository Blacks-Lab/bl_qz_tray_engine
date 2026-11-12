# -*- coding: utf-8 -*-

import base64
from urllib.parse import parse_qs, urlparse

from odoo import _, http
from odoo.exceptions import AccessError, UserError
from odoo.http import request

# Tope de lo que se firma en una sola solicitud (un ticket con logo ronda los cientos de KB).
MAX_SIGN_CHARS = 2_000_000

from ..bl_qz_signing_utils import (
    QZ_SIGNATURE_ALGORITHM,
    ensure_company_signing_material,
    has_company_signing_material,
    normalize_pem,
)


class BlQzSigningController(http.Controller):

    @staticmethod
    def _to_int(value):
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return 0
        return parsed if parsed > 0 else 0

    @staticmethod
    def _user_companies():
        # Solo las companias a las que el usuario pertenece: el navegador manda el id de
        # compania/TPV y antes se le creia sin comprobar nada (H1).
        return request.env.user.company_ids

    def _resolve_company(self, pos_config_id=None, device_id=None, company_id=None):
        env = request.env
        allowed = self._user_companies()

        config_candidates = [
            pos_config_id,
            request.params.get("pos_config_id"),
            request.params.get("config_id"),
            request.session.get("pos_config_id"),
            request.session.get("config_id"),
        ]

        referrer = request.httprequest.referrer or ""
        if referrer:
            query = parse_qs(urlparse(referrer).query)
            config_candidates.append((query.get("config_id") or [None])[0])
            config_candidates.append((query.get("pos_config_id") or [None])[0])

        for candidate in config_candidates:
            candidate_id = self._to_int(candidate)
            if not candidate_id:
                continue
            pos_config = env["pos.config"].sudo().browse(candidate_id)
            if pos_config.exists() and pos_config.company_id in allowed:
                return pos_config.company_id.sudo()

        company_candidate_id = self._to_int(company_id or request.params.get("company_id"))
        if company_candidate_id:
            company = env["res.company"].sudo().browse(company_candidate_id)
            if company.exists() and company in allowed:
                return company

        device_candidate_id = self._to_int(device_id or request.params.get("device_id"))
        if device_candidate_id:
            device = env["bl.qz.device"].sudo().browse(device_candidate_id)
            # Un equipo puede no tener compania (es hardware, no pertenece a ninguna).
            # En ese caso hay que seguir bajando en la cadena hasta env.company en vez de
            # devolver un recordset vacio, que haria fallar la firma con "firma desactivada".
            if device.exists() and device.company_id and device.company_id in allowed:
                return device.company_id.sudo()

        return env.company.sudo()

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
        hashes, _padding, _loader = BlQzSigningController._get_cryptography_primitives()
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
    def _require_existing_material_unless_admin(company):
        # Solo un administrador puede CREAR el material de firma. Quien opera el punto de venta
        # usa el certificado que ya existe; si todavia no hay uno, se le avisa en vez de generarlo.
        if request.env.user.has_group("base.group_system"):
            return
        if not has_company_signing_material(company.sudo()):
            raise UserError(_(
                "Todavia no hay un certificado de firma para esta compania. "
                "Pidale a un administrador que lo genere desde Ajustes."
            ))

    def _get_certificate_pem(self, pos_config_id=None, device_id=None, company_id=None):
        company = self._resolve_company(
            pos_config_id=pos_config_id,
            device_id=device_id,
            company_id=company_id,
        )
        if not company.bl_qz_signing_enabled:
            raise UserError(_(
                "La firma de QZ Tray esta desactivada para la compania actual. "
                "Active la opcion de firma en la configuracion de la compania."
            ))

        self._require_existing_material_unless_admin(company)
        params = request.env["ir.config_parameter"].sudo()
        base_url = params.get_param("web.base.url", "")
        try:
            certificate, private_key = ensure_company_signing_material(
                company,
                base_url=base_url,
            )
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

    def _get_private_key_pem(self, pos_config_id=None, device_id=None, company_id=None):
        company = self._resolve_company(
            pos_config_id=pos_config_id,
            device_id=device_id,
            company_id=company_id,
        )
        if not company.bl_qz_signing_enabled:
            raise UserError(_(
                "La firma de QZ Tray esta desactivada para la compania actual. "
                "Active la opcion de firma en la configuracion de la compania."
            ))

        self._require_existing_material_unless_admin(company)
        params = request.env["ir.config_parameter"].sudo()
        base_url = params.get_param("web.base.url", "")
        try:
            cert, private_key = ensure_company_signing_material(
                company,
                base_url=base_url,
            )
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
    def qz_certificate(self, pos_config_id=None, device_id=None, company_id=None):
        certificate = self._get_certificate_pem(
            pos_config_id=pos_config_id,
            device_id=device_id,
            company_id=company_id,
        )

        return {
            "certificate": certificate,
            "algorithm": QZ_SIGNATURE_ALGORITHM,
        }

    @http.route(
        "/bl_qz/certificate/download",
        type="http",
        auth="user",
    )
    def qz_certificate_download(self, pos_config_id=None, device_id=None, company_id=None):
        certificate = self._get_certificate_pem(
            pos_config_id=pos_config_id,
            device_id=device_id,
            company_id=company_id,
        )
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
    def qz_sign(self, data_to_sign=None, pos_config_id=None, device_id=None, company_id=None):
        # Solo quien opera el punto de venta (o administra) puede pedir firmas: antes
        # cualquier usuario con sesion, hasta uno de portal, obtenia la firma de lo que
        # quisiera (H2). El tope de tamanio frena abusos; un ticket con logo pesa mucho menos.
        user = request.env.user
        if not (user.has_group("point_of_sale.group_pos_user") or user.has_group("base.group_system")):
            raise AccessError(_("No tiene permiso para firmar solicitudes de QZ Tray."))
        if not data_to_sign or not isinstance(data_to_sign, str):
            raise UserError(_("No hay contenido para firmar en la solicitud QZ."))
        if len(data_to_sign) > MAX_SIGN_CHARS:
            raise UserError(_("La solicitud QZ es demasiado grande para firmar."))

        private_key_pem = self._get_private_key_pem(
            pos_config_id=pos_config_id,
            device_id=device_id,
            company_id=company_id,
        )
        # No se llama "_": ese nombre tapaba la funcion de traduccion de todo el metodo y un
        # pedido sin contenido terminaba en UnboundLocalError en vez del aviso (N31).
        _hashes, padding, load_pem_private_key = self._get_cryptography_primitives()

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
