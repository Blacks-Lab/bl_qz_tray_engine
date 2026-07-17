/** @odoo-module */

const DEFAULT_LOGO_WIDTH = 150;
const DEFAULT_LOGO_HEIGHT = 80;
const MIN_LOGO_SIZE = 24;
const MAX_LOGO_WIDTH = 560;
const MAX_LOGO_HEIGHT = 300;
const DEFAULT_QZ_LOGO_SCALE_PERCENT = 100;
const MIN_QZ_LOGO_SCALE_PERCENT = 50;
const MAX_QZ_LOGO_SCALE_PERCENT = 300;

// Keep the same threshold used by the backend "logo + cabecera" test so
// invoice/budget/comanda render the logo with the same sharpness profile.
export const BINARIZATION_THRESHOLD = 170;

// ===== CACHE DE RASTERIZADO =====
// El rasterizado ESC/POS es determinista: mismas entradas => mismo base64.
// Cachear el resultado no cambia un solo byte del output, solo evita recalcularlo
// en cada ticket. Cache LRU acotada, se limpia sola al recargar la sesion POS.
const RASTER_CACHE_MAX_ENTRIES = 12;
const normalizedLogoCache = new Map();
const companyLogoCache = new Map();
const arcaRasterCache = new Map();

function cacheGet(cache, key) {
    if (!cache.has(key)) {
        return undefined;
    }
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
}

function cacheSet(cache, key, value) {
    if (cache.has(key)) {
        cache.delete(key);
    }
    cache.set(key, value);
    while (cache.size > RASTER_CACHE_MAX_ENTRIES) {
        cache.delete(cache.keys().next().value);
    }
    return value;
}

function fnv1aHash(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16);
}

function buildSourceFingerprint(value) {
    const text = String(value || "");
    return `${text.length}:${fnv1aHash(text)}`;
}

export function clearBlQzRasterCaches() {
    normalizedLogoCache.clear();
    companyLogoCache.clear();
    arcaRasterCache.clear();
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function toPositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getLogoAlignment(posConfig = {}) {
    const align = String(posConfig.logo_alignment || "center").toLowerCase();
    if (align === "left" || align === "right" || align === "center") {
        return align;
    }
    return "center";
}

function getLogoSize(posConfig = {}) {
    const baseWidth = clamp(
        toPositiveInt(posConfig.logo_width, DEFAULT_LOGO_WIDTH),
        MIN_LOGO_SIZE,
        MAX_LOGO_WIDTH
    );
    const baseHeight = clamp(
        toPositiveInt(posConfig.logo_height, DEFAULT_LOGO_HEIGHT),
        MIN_LOGO_SIZE,
        MAX_LOGO_HEIGHT
    );
    const scalePercent = clamp(
        toPositiveInt(posConfig.qz_logo_scale_percent, DEFAULT_QZ_LOGO_SCALE_PERCENT),
        MIN_QZ_LOGO_SCALE_PERCENT,
        MAX_QZ_LOGO_SCALE_PERCENT
    );

    return {
        width: clamp(Math.round((baseWidth * scalePercent) / 100), MIN_LOGO_SIZE, MAX_LOGO_WIDTH),
        height: clamp(Math.round((baseHeight * scalePercent) / 100), MIN_LOGO_SIZE, MAX_LOGO_HEIGHT),
        keepAspectRatio: posConfig.logo_keep_aspect_ratio !== false,
        alignment: getLogoAlignment(posConfig),
    };
}

function drawLogo(ctx, img, logoSize) {
    const width = logoSize.width;
    const height = logoSize.height;

    if (!logoSize.keepAspectRatio || !img.width || !img.height) {
        ctx.drawImage(img, 0, 0, width, height);
        return;
    }

    const scale = Math.min(width / img.width, height / img.height);
    const drawWidth = Math.max(1, Math.floor(img.width * scale));
    const drawHeight = Math.max(1, Math.floor(img.height * scale));
    let offsetX = Math.floor((width - drawWidth) / 2);
    if (logoSize.alignment === "left") {
        offsetX = 0;
    } else if (logoSize.alignment === "right") {
        offsetX = Math.max(width - drawWidth, 0);
    }
    const offsetY = Math.floor((height - drawHeight) / 2);

    ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);
}

function toImageDataUrl(value) {
    if (!value || typeof value !== "string") {
        return "";
    }
    const cleaned = value.trim();
    if (!cleaned) {
        return "";
    }
    if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(cleaned)) {
        return cleaned;
    }
    const base64 = cleaned.replace(/\s+/g, "");
    return `data:image/png;base64,${base64}`;
}

function dataUrlToBase64(dataUrl) {
    if (!dataUrl || typeof dataUrl !== "string") {
        return "";
    }
    const match = dataUrl.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
    return match ? match[1].replace(/\s+/g, "") : "";
}

function extractLogoBase64(receiptData = {}) {
    const candidates = [
        receiptData.company_logo_base64,
        receiptData.headerData?.company_logo_base64,
        receiptData.headerData?.pos?.company_logo_base64,
    ];

    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "string") {
            continue;
        }
        const cleaned = candidate.trim();
        if (!cleaned) {
            continue;
        }
        const match = cleaned.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
        return match ? match[1] : cleaned.replace(/\s+/g, "");
    }

    return "";
}

function getCompanyId(receiptData = {}) {
    const candidates = [
        receiptData.headerData?.company?.id,
        receiptData.headerData?.pos?.company?.id,
        receiptData.company?.id,
    ];
    for (const candidate of candidates) {
        const id = Number(candidate);
        if (Number.isInteger(id) && id > 0) {
            return id;
        }
    }
    return null;
}

async function loadLogoFromCompany(companyId, logoSize) {
    if (!companyId || typeof Image === "undefined" || typeof document === "undefined") {
        return "";
    }

    const cacheKey = `company|${companyId}|${logoSize.width}|${logoSize.height}|${logoSize.keepAspectRatio}|${logoSize.alignment}`;
    const cachedValue = cacheGet(companyLogoCache, cacheKey);
    if (cachedValue) {
        return cachedValue;
    }

    const rendered = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const width = logoSize.width;
                const height = logoSize.height;
                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    resolve("");
                    return;
                }

                ctx.fillStyle = "#FFFFFF";
                ctx.fillRect(0, 0, width, height);
                drawLogo(ctx, img, logoSize);
                resolve(dataUrlToBase64(canvas.toDataURL("image/png")));
            } catch {
                resolve("");
            }
        };
        img.onerror = () => resolve("");
        img.crossOrigin = "anonymous";
        img.src = `/web/image?model=res.company&id=${companyId}&field=logo`;
    });

    if (rendered) {
        cacheSet(companyLogoCache, cacheKey, rendered);
    }
    return rendered;
}

export async function normalizeLogoForEscPos(base64ImageData, options = {}) {
    if (!base64ImageData || typeof Image === "undefined" || typeof document === "undefined") {
        return "";
    }

    const width = clamp(
        toPositiveInt(options.width, DEFAULT_LOGO_WIDTH),
        MIN_LOGO_SIZE,
        MAX_LOGO_WIDTH
    );
    const height = clamp(
        toPositiveInt(options.height, DEFAULT_LOGO_HEIGHT),
        MIN_LOGO_SIZE,
        MAX_LOGO_HEIGHT
    );
    const keepAspectRatio = options.keepAspectRatio !== false;
    const alignment = ["left", "right", "center"].includes(options.alignment)
        ? options.alignment
        : "center";

    const imageDataUrl = toImageDataUrl(base64ImageData);
    if (!imageDataUrl) {
        return "";
    }

    const cacheKey = `norm|${width}|${height}|${keepAspectRatio}|${alignment}|${buildSourceFingerprint(imageDataUrl)}`;
    const cachedValue = cacheGet(normalizedLogoCache, cacheKey);
    if (cachedValue) {
        return cachedValue;
    }

    const rendered = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    resolve(dataUrlToBase64(imageDataUrl));
                    return;
                }

                ctx.fillStyle = "#FFFFFF";
                ctx.fillRect(0, 0, width, height);
                drawLogo(ctx, img, { width, height, keepAspectRatio, alignment });

                const imageData = ctx.getImageData(0, 0, width, height);
                const pixels = imageData.data;
                for (let i = 0; i < pixels.length; i += 4) {
                    const r = pixels[i];
                    const g = pixels[i + 1];
                    const b = pixels[i + 2];
                    const alpha = pixels[i + 3];

                    if (alpha < 40) {
                        pixels[i] = 255;
                        pixels[i + 1] = 255;
                        pixels[i + 2] = 255;
                        pixels[i + 3] = 255;
                        continue;
                    }

                    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
                    const bw = luma < BINARIZATION_THRESHOLD ? 0 : 255;
                    pixels[i] = bw;
                    pixels[i + 1] = bw;
                    pixels[i + 2] = bw;
                    pixels[i + 3] = 255;
                }

                ctx.putImageData(imageData, 0, 0);
                resolve(dataUrlToBase64(canvas.toDataURL("image/png")));
            } catch {
                resolve(dataUrlToBase64(imageDataUrl));
            }
        };
        img.onerror = () => resolve(dataUrlToBase64(imageDataUrl));
        img.crossOrigin = "anonymous";
        img.src = imageDataUrl;
    });

    if (rendered) {
        cacheSet(normalizedLogoCache, cacheKey, rendered);
    }
    return rendered;
}

export async function prepareLogoForEscPos(receiptData = {}, posConfig = {}, orm = null) {
    const logoSize = getLogoSize(posConfig || {});

    let logoBase64 = extractLogoBase64(receiptData || {});
    if (!logoBase64) {
        const companyId = getCompanyId(receiptData || {});
        if (companyId) {
            logoBase64 = await loadLogoFromCompany(companyId, logoSize);
        }
        if (!logoBase64 && orm && companyId) {
            try {
                const company = await orm.call("res.company", "read", [[companyId], ["logo"]]);
                logoBase64 = company?.[0]?.logo || "";
            } catch {
                // best effort fallback
            }
        }
    }
    if (!logoBase64) {
        return "";
    }

    return normalizeLogoForEscPos(logoBase64, {
        width: logoSize.width,
        height: logoSize.height,
        keepAspectRatio: logoSize.keepAspectRatio,
        alignment: logoSize.alignment,
    });
}

function drawFittedText(ctx, text, x, y, maxWidth, spec = {}) {
    const {
        style = "normal",
        weight = "400",
        size = 16,
        minSize = 10,
        family = '"Helvetica Neue", Arial, sans-serif',
    } = spec;

    let fontSize = size;
    while (fontSize > minSize) {
        ctx.font = `${style} ${weight} ${fontSize}px ${family}`;
        if (ctx.measureText(text).width <= maxWidth) {
            break;
        }
        fontSize -= 1;
    }

    ctx.fillText(text, x, y);
}

function resolveFittedFontSize(ctx, texts, maxWidth, spec = {}) {
    const {
        style = "normal",
        weight = "400",
        size = 16,
        minSize = 10,
        family = '"Helvetica Neue", Arial, sans-serif',
    } = spec;

    const samples = (Array.isArray(texts) ? texts : [texts]).map((text) => String(text || ""));
    let fontSize = size;
    while (fontSize > minSize) {
        ctx.font = `${style} ${weight} ${fontSize}px ${family}`;
        if (samples.every((text) => ctx.measureText(text).width <= maxWidth)) {
            break;
        }
        fontSize -= 1;
    }
    return fontSize;
}

export function buildArcaAuthorizationRasterBase64(options = {}) {
    if (typeof document === "undefined") {
        return "";
    }

    const tuning = options.tuning || {};
    const width = toPositiveInt(options.width, 470);
    const height = toPositiveInt(options.height, 250);

    let arcaCacheKey = "";
    try {
        arcaCacheKey = `arca|${width}|${height}|${JSON.stringify(tuning)}`;
    } catch {
        arcaCacheKey = "";
    }
    if (arcaCacheKey) {
        const cachedValue = cacheGet(arcaRasterCache, arcaCacheKey);
        if (cachedValue) {
            return cachedValue;
        }
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return "";
    }

    const colors = tuning.colors || {};
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, width, height);
    ctx.textBaseline = "top";

    const header = tuning.header || {};
    const auth = tuning.authorization || {};
    const note = tuning.note || {};

    const headerX = toNonNegativeInt(header.x, 16);
    const titleY = toNonNegativeInt(header.titleY, 12);
    const agencyY = titleY + toNonNegativeInt(header.arcaToAgencyGap, 60);
    const customsY = agencyY + toNonNegativeInt(header.agencyToCustomsGap, 28);
    const authorizationY = customsY + toNonNegativeInt(header.agencyToAuthorizationGap, 20);

    ctx.fillStyle = colors.header || "#3f4346";
    drawFittedText(
        ctx,
        "ARCA",
        headerX,
        titleY,
        width - toNonNegativeInt(header.titleMaxWidthPadding, 28),
        {
            weight: "900",
            size: toPositiveInt(header.titleFontSize, 54),
            minSize: toPositiveInt(header.titleMinFontSize, 45),
            family: '"Arial Black", "Helvetica Neue", Arial, sans-serif',
        }
    );
    drawFittedText(
        ctx,
        "AGENCIA DE RECAUDACION",
        headerX,
        agencyY,
        width - toNonNegativeInt(header.subtitle1MaxWidthPadding, 28),
        {
            weight: "500",
            size: toPositiveInt(header.subtitleFontSize, 16),
            minSize: toPositiveInt(header.subtitleMinFontSize, 15),
        }
    );
    drawFittedText(
        ctx,
        "Y CONTROL ADUANERO",
        toNonNegativeInt(header.subtitle2X, 36),
        customsY,
        width - toNonNegativeInt(header.subtitle2MaxWidthPadding, 50),
        {
            weight: "500",
            size: toPositiveInt(header.subtitleFontSize, 16),
            minSize: toPositiveInt(header.subtitleMinFontSize, 15),
        }
    );

    ctx.fillStyle = colors.text || "#000000";
    drawFittedText(
        ctx,
        "Comprobante Autorizado",
        toNonNegativeInt(auth.x, 14),
        authorizationY,
        width - toNonNegativeInt(auth.maxWidthPadding, 28),
        {
            style: "italic",
            weight: "700",
            size: toPositiveInt(auth.fontSize, 26),
            minSize: toPositiveInt(auth.minSize || auth.minFontSize, 20),
        }
    );

    const noteLines = [
        "Esta Agencia no se responsabiliza por los datos ingresados",
        "en el detalle de la operacion",
    ];
    const noteX = toNonNegativeInt(note.x, 14);
    const noteYBase = authorizationY + toNonNegativeInt(auth.toNoteGap, 32);
    const noteMaxWidth = width - toNonNegativeInt(note.maxWidthPadding, 28);
    const noteStyle = {
        style: "italic",
        weight: "500",
        size: toPositiveInt(note.fontSize, 17),
        minSize: toPositiveInt(note.minSize, 16),
    };
    const sharedNoteSize = resolveFittedFontSize(ctx, noteLines, noteMaxWidth, noteStyle);

    drawFittedText(ctx, noteLines[0], noteX, noteYBase, noteMaxWidth, {
        ...noteStyle,
        size: sharedNoteSize,
        minSize: sharedNoteSize,
    });
    drawFittedText(
        ctx,
        noteLines[1],
        noteX,
        noteYBase + toNonNegativeInt(note.lineGap, 24),
        noteMaxWidth,
        {
            ...noteStyle,
            size: sharedNoteSize,
            minSize: sharedNoteSize,
        }
    );

    const rendered = dataUrlToBase64(canvas.toDataURL("image/png"));
    if (arcaCacheKey && rendered) {
        cacheSet(arcaRasterCache, arcaCacheKey, rendered);
    }
    return rendered;
}

/**
 * Mapea la densidad configurada al variante "legacy" que mejor compatibiliza
 * con firmware ESC/POS antiguo (igual criterio que la prueba de cabecera backend).
 */
export function getEscPosImageDotDensity(posConfig = {}) {
    const density = String(posConfig?.qz_logo_dot_density || "double").toLowerCase();
    return density === "single" ? "single-legacy" : "double-legacy";
}

/**
 * Construye el objeto imagen que QZ Tray entiende como raster ESC/POS.
 * IMPORTANTE: si se envía el base64 como string plano, QZ lo trata como comando RAW
 * y la impresora escupe el texto base64. Por eso SIEMPRE debe ir envuelto así.
 * Espeja exactamente el objeto usado por qz_logo_header_test_backend.js (que funciona).
 *
 * @param {string} base64Data  PNG en base64 (sin prefijo data:)
 * @param {{dotDensity?: string}} options
 * @returns {object|null}  objeto QZ image, o null si no hay datos
 */
export function buildQzEscPosImageObject(base64Data, options = {}) {
    const data = typeof base64Data === "string" ? base64Data.trim() : "";
    if (!data) {
        return null;
    }
    return {
        type: "raw",
        format: "image",
        flavor: "base64",
        data,
        options: {
            language: "ESCPOS",
            imageEncoding: "esc_asterisk",
            dotDensity: options.dotDensity || "double-legacy",
            x: 0,
            y: 0,
        },
    };
}
