import type { ReceiptData } from "./receipt";

/**
 * Client for `POST /api/process-receipt` (browser side only).
 *
 * Returns a union result instead of throwing exceptions so the UI can
 * paint the error with a retry directly. Never uses `any`: every
 * incoming payload is validated with type guards before narrowing the type.
 */

const ENDPOINT = "/api/process-receipt";
/** The server can take ~50 s; extra margin on the client before aborting. */
const CLIENT_TIMEOUT_MS = 75_000;
/**
 * Approximates the decoded bytes of a data URL (base64 ≈ 4/3 of the original)
 * to reject on the client what the server would reject with 413, without
 * paying the upload time.
 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function estimatedImageBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const payload = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  return Math.floor((payload.length * 3) / 4);
}

/** Error translated into something the UI can display without parsing. */
export type ProcessError = {
  /** HTTP status of the response; `null` if the network failed or there was a timeout. */
  status: number | null;
  /** Human-readable message per status (or for a network failure). */
  message: string;
  /** The `error` field exactly as the API returned it, if present. */
  detail: string | null;
};

export type ProcessOutcome =
  | { ok: true; receipt: ReceiptData }
  | { ok: false; error: ProcessError };

/** Base message per status; the server's detail is appended separately. */
const STATUS_COPY: Record<number, string> = {
  400: "La imagen no es válida o no se pudo leer.",
  413: "La imagen supera el límite de tamaño (4 MB). Prueba con una foto más ligera.",
  500: "El servidor no tiene configurado el servicio de IA.",
  502: "El servicio de IA falló o no devolvió datos utilizables. Inténtalo de nuevo.",
  504: "El análisis superó el tiempo límite (~50 s). Inténtalo de nuevo.",
};

const NETWORK_MESSAGE = "No se pudo conectar con el servidor. Comprueba tu conexión e inténtalo de nuevo.";
const TIMEOUT_MESSAGE = "El servidor tardó demasiado en responder. Inténtalo de nuevo.";

function failure(status: number | null, message: string, detail: string | null): ProcessOutcome {
  return { ok: false, error: { status, message, detail } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readErrorDetail(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const detail = payload.error;
  if (typeof detail !== "string") return null;
  const trimmed = detail.trim();
  return trimmed === "" ? null : trimmed;
}

function isReceiptProduct(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.nombre === "string" &&
    isFiniteNumber(value.cantidad) &&
    isFiniteNumber(value.precio_unitario) &&
    isFiniteNumber(value.iva_porcentaje) &&
    isFiniteNumber(value.subtotal) &&
    (value.codigo_producto === undefined || typeof value.codigo_producto === "string")
  );
}

/** Validates that a 200 fulfills the `ReceiptData` contract before using it. */
function isReceiptData(value: unknown): value is ReceiptData {
  if (!isRecord(value)) return false;
  if (typeof value.establecimiento !== "string") return false;
  if (value.fecha !== undefined && typeof value.fecha !== "string") return false;
  if (!Array.isArray(value.productos) || !value.productos.every(isReceiptProduct)) return false;
  return isFiniteNumber(value.impuestos_totales) && isFiniteNumber(value.gran_total);
}

/**
 * Sends the image (full data URL) to the endpoint and returns the
 * normalized receipt, or a `ProcessError` ready to display in the UI.
 */
export async function processReceipt(image: string): Promise<ProcessOutcome> {
  if (image.trim() === "") {
    return failure(null, "No hay imagen que enviar.", null);
  }

  if (estimatedImageBytes(image) > MAX_IMAGE_BYTES) {
    // Rejected on the client: there was no response, so `status` stays `null`.
    return failure(null, STATUS_COPY[413], null);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
      signal: controller.signal,
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (controller.signal.aborted) {
      return failure(null, TIMEOUT_MESSAGE, null);
    }

    if (!response.ok) {
      const status = response.status;
      const message = STATUS_COPY[status] ?? `El servidor respondió con un error (HTTP ${status}).`;
      return failure(status, message, readErrorDetail(payload));
    }

    if (!isReceiptData(payload)) {
      return failure(
        response.status,
        "El servidor devolvió una respuesta inesperada. Inténtalo de nuevo.",
        null,
      );
    }

    return { ok: true, receipt: payload };
  } catch {
    return controller.signal.aborted
      ? failure(null, TIMEOUT_MESSAGE, null)
      : failure(null, NETWORK_MESSAGE, null);
  } finally {
    clearTimeout(timer);
  }
}
