/** @odoo-module */

import { ensureQzSecurityConfigured } from "./bl_qz_security";

const CONNECT_OPTIONS = {
    retries: 2,
    delay: 0.3,
};

let connectPromise = null;
let isDetecting = false;

function normalizePrinterName(value) {
    return typeof value === "string" ? value.trim() : "";
}

function normalizePrinterList(value) {
    const values = Array.isArray(value) ? value : [value];
    const unique = new Set();

    for (const candidate of values) {
        const printerName = normalizePrinterName(candidate);
        if (printerName) {
            unique.add(printerName);
        }
    }

    return Array.from(unique);
}

async function ensureConnected(qz) {
    if (qz.websocket.isActive()) {
        return;
    }

    if (!connectPromise) {
        connectPromise = qz.websocket.connect(CONNECT_OPTIONS).finally(() => {
            connectPromise = null;
        });
    }

    await connectPromise;
}

function findPrinterInput(triggerElement) {
    const fieldSelectors = [
        ".o_field_widget[name='qz_tray_printer_name'] input",
        ".o_field_widget[name='pos_qz_tray_printer_name'] input",
        "input[name='qz_tray_printer_name']",
        "input[name='pos_qz_tray_printer_name']",
    ];

    const scopes = [
        triggerElement?.closest(".o_setting_right_pane"),
        triggerElement?.closest(".content-group"),
        triggerElement?.closest(".row"),
        document,
    ].filter(Boolean);

    for (const scope of scopes) {
        for (const selector of fieldSelectors) {
            const fieldInput = scope.querySelector(selector);
            if (fieldInput) {
                return fieldInput;
            }
        }
    }

    return null;
}

function setFieldValue(fieldInput, value) {
    fieldInput.value = value;
    fieldInput.dispatchEvent(new Event("input", { bubbles: true }));
    fieldInput.dispatchEvent(new Event("change", { bubbles: true }));
}

function choosePrinterWithPrompt(printers) {
    if (!printers.length) {
        return "";
    }

    if (printers.length === 1) {
        return printers[0];
    }

    const options = printers.map((printer, index) => `${index + 1}. ${printer}`).join("\n");
    const selected = window.prompt(
        `Impresoras detectadas por QZ Tray:\n\n${options}\n\nIngresa el numero de la impresora a usar:`,
        "1"
    );

    if (selected === null) {
        return "";
    }

    const index = Number.parseInt(selected, 10) - 1;
    if (!Number.isFinite(index) || index < 0 || index >= printers.length) {
        window.alert("Seleccion invalida. No se actualizo la impresora.");
        return "";
    }

    return printers[index];
}

async function detectPrintersAndFillField(triggerElement) {
    const qz = await ensureQzSecurityConfigured();

    const targetInput = findPrinterInput(triggerElement);
    if (!targetInput) {
        window.alert("No se encontro el campo de impresora QZ en esta vista.");
        return;
    }

    await ensureConnected(qz);

    const detected = await qz.printers.find();
    const printers = normalizePrinterList(detected);

    if (!printers.length) {
        window.alert("QZ Tray no devolvio impresoras en este equipo.");
        return;
    }

    const selectedPrinter = choosePrinterWithPrompt(printers);
    if (!selectedPrinter) {
        return;
    }

    setFieldValue(targetInput, selectedPrinter);
    window.alert(`Impresora seleccionada: ${selectedPrinter}`);
}

document.addEventListener("click", async (event) => {
    const trigger = event.target?.closest?.(".bl-qz-backend-detect-btn");
    if (!trigger) {
        return;
    }

    event.preventDefault();
    if (isDetecting) {
        return;
    }

    isDetecting = true;
    const originalText = trigger.textContent;
    trigger.classList.add("disabled");
    trigger.textContent = "Buscando...";

    try {
        await detectPrintersAndFillField(trigger);
    } catch (error) {
        const detail = error?.message || "No se pudo detectar impresoras con QZ Tray.";
        window.alert(detail);
    } finally {
        trigger.textContent = originalText;
        trigger.classList.remove("disabled");
        isDetecting = false;
    }
});
