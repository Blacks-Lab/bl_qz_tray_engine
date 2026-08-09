# -*- coding: utf-8 -*-

from datetime import datetime, timedelta
from urllib.parse import urlparse

QZ_PARAM_SIGNING_ENABLED = "bl_qz_tray.qz_signing_enabled"
QZ_PARAM_CERTIFICATE_PEM = "bl_qz_tray.qz_signing_certificate_pem"
QZ_PARAM_PRIVATE_KEY_PEM = "bl_qz_tray.qz_signing_private_key_pem"
QZ_SIGNATURE_ALGORITHM = "SHA512"


def _get_cryptography_dependencies():
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except Exception as error:
        raise RuntimeError(
            "La dependencia Python 'cryptography' no esta disponible para la firma de QZ Tray."
        ) from error

    return x509, hashes, serialization, rsa, NameOID


def normalize_pem(value):
    if not value:
        return ""

    lines = [line.strip() for line in str(value).replace("\r", "").split("\n") if line.strip()]
    if not lines:
        return ""

    return "\n".join(lines) + "\n"


def param_is_enabled(raw_value):
    value = str(raw_value or "True").strip().lower()
    return value in {"1", "true", "yes", "on"}


def get_common_name_from_base_url(base_url):
    if not base_url:
        return "odoo.local"

    parsed = urlparse(base_url)
    host = parsed.hostname
    if host:
        return host

    base_url = str(base_url).strip()
    if "://" not in base_url:
        parsed = urlparse(f"https://{base_url}")
        if parsed.hostname:
            return parsed.hostname

    return "odoo.local"


def generate_self_signed_material(common_name):
    x509, hashes, serialization, rsa, NameOID = _get_cryptography_dependencies()

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    subject = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, common_name),
    ])

    now_utc = datetime.utcnow()
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now_utc - timedelta(days=1))
        .not_valid_after(now_utc + timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(common_name)]), critical=False)
        .sign(private_key=private_key, algorithm=hashes.SHA256())
    )

    private_key_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")

    certificate_pem = certificate.public_bytes(serialization.Encoding.PEM).decode("utf-8")

    return normalize_pem(certificate_pem), normalize_pem(private_key_pem)


def has_signing_material(params):
    cert = normalize_pem(params.get_param(QZ_PARAM_CERTIFICATE_PEM, ""))
    key = normalize_pem(params.get_param(QZ_PARAM_PRIVATE_KEY_PEM, ""))
    return bool(cert and key)


def has_company_signing_material(company):
    company.ensure_one()
    cert = normalize_pem(company.bl_qz_certificate_pem)
    key = normalize_pem(company.bl_qz_private_key_pem)
    return bool(cert and key)


def ensure_company_signing_material(company, force=False, base_url=""):
    company.ensure_one()

    cert = normalize_pem(company.bl_qz_certificate_pem)
    key = normalize_pem(company.bl_qz_private_key_pem)
    if cert and key and not force:
        return cert, key

    common_name = get_common_name_from_base_url(base_url or company.website or "")
    cert, key = generate_self_signed_material(common_name)

    company.sudo().write(
        {
            "bl_qz_certificate_pem": cert,
            "bl_qz_private_key_pem": key,
            "bl_qz_signing_enabled": True,
        }
    )

    return cert, key


def ensure_signing_material(params, force=False):
    cert = normalize_pem(params.get_param(QZ_PARAM_CERTIFICATE_PEM, ""))
    key = normalize_pem(params.get_param(QZ_PARAM_PRIVATE_KEY_PEM, ""))

    if cert and key and not force:
        return cert, key

    base_url = params.get_param("web.base.url", "")
    common_name = get_common_name_from_base_url(base_url)
    cert, key = generate_self_signed_material(common_name)

    params.set_param(QZ_PARAM_CERTIFICATE_PEM, cert)
    params.set_param(QZ_PARAM_PRIVATE_KEY_PEM, key)
    params.set_param(QZ_PARAM_SIGNING_ENABLED, "True")

    return cert, key
