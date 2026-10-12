/**
 * Data contract for a receipt and normalization utilities.
 *
 * Consumed by the `POST /api/process-receipt` API and the UI. Validation and
 * normalization happen here so that the endpoint response is always valid JSON
 * with correct types.
 */

/** Receipt line item. */
export interface ReceiptProduct {
  /** Internal code/SKU if printed. Absent when it cannot be read. */
  codigo_producto?: string;
  nombre: string;
  cantidad: number;
  precio_unitario: number;
  iva_porcentaje: number;
  subtotal: number;
}

/** Data extracted from a receipt. */
export interface ReceiptData {
  establecimiento: string;
  /** Receipt date. Absent when it cannot be read. */
  fecha?: string;
  productos: ReceiptProduct[];
  impuestos_totales: number;
  gran_total: number;
}

/**
 * Strict JSON Schema sent to OpenRouter with
 * `response_format: { type: "json_schema", json_schema: {...} }`.
 *
 * In strict mode every field must appear in `required`, so the optional ones
 * (`fecha`, `codigo_producto`) are declared as string and `""` is sent when
 * they are missing; `normalizeReceiptData` strips them afterwards.
 */
export const RECEIPT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    establecimiento: {
      type: "string",
      description: "Nombre del comercio que emite el tique",
    },
    fecha: {
      type: "string",
      description: "Fecha del tique en formato AAAA-MM-DD, o cadena vacía si no se lee",
    },
    productos: {
      type: "array",
      description: "Artículos comprados",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          codigo_producto: {
            type: "string",
            description: "Código/SKU del producto, o cadena vacía si no se lee",
          },
          nombre: { type: "string", description: "Descripción del producto" },
          cantidad: { type: "number", description: "Unidades (por ejemplo 2)" },
          precio_unitario: {
            type: "number",
            description: "Precio por unidad SIN símbolo de moneda y SIN separadores de miles",
          },
          iva_porcentaje: {
            type: "number",
            description: "IVA en porcentaje (21 para el 21%)",
          },
          subtotal: {
            type: "number",
            description: "cantidad × precio_unitario, SIN símbolo de moneda",
          },
        },
        required: ["codigo_producto", "nombre", "cantidad", "precio_unitario", "iva_porcentaje", "subtotal"],
      },
    },
    impuestos_totales: { type: "number", description: "Suma de impuestos, SIN símbolo de moneda" },
    gran_total: { type: "number", description: "Total a pagar, SIN símbolo de moneda" },
  },
  required: ["establecimiento", "fecha", "productos", "impuestos_totales", "gran_total"],
};

/* -------------------------------------------------------------------------- */
/*                              Normalization                                 */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Converts a model value into a `number`.
 *
 * Accepts numbers and strings like `"$1.234,56"`, `"21%"`, `" 12,50 "`.
 * Returns `null` when the value is not recoverable.
 */
export function parseAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const cleaned = value.replace(/[^0-9.,-]/g, "");
  if (cleaned === "" || !/\d/.test(cleaned)) return null;

  const negative = cleaned.trimStart().startsWith("-");
  let body = cleaned.replace(/-/g, "");
  const dots = body.split(".").length - 1;
  const commas = body.split(",").length - 1;

  if (dots > 0 && commas > 0) {
    // The last separator used is the decimal one; the other groups thousands.
    if (body.lastIndexOf(",") > body.lastIndexOf(".")) {
      body = body.replace(/\./g, "").replace(/,/g, ".");
    } else {
      body = body.replace(/,/g, "");
    }
  } else if (commas > 0) {
    // Spanish format: a single comma is decimal, multiple commas are thousands separators.
    body = commas === 1 ? body.replace(",", ".") : body.replace(/,/g, "");
  } else if (dots > 0) {
    const parts = body.split(".");
    const isThousands =
      dots === 1 && parts[1].length === 3 && parts[0].length >= 1 && parts[0].length <= 3 && parts[0] !== "0";
    // "1.234" (Spanish, thousands) vs "12.50" (decimal).
    if (isThousands) body = parts[0] + parts[1];
  }

  const parsed = Number(body);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

/** Converts to a usable string; `null` when there is nothing usable. */
function asText(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Rounds to 2 decimal places.
 *
 * Returns `null` when the result is not finite (`Infinity`/`NaN`), because
 * `JSON.stringify` would serialize those values as `null`, violating the
 * `number` type of the response.
 */
function round2(value: number): number | null {
  const rounded = Math.round(value * 100) / 100;
  return Number.isFinite(rounded) ? rounded : null;
}

/** Sum of `subtotal × iva_porcentaje / 100` for each line; `null` on overflow. */
function deriveImpuestos(productos: ReceiptProduct[]): number | null {
  const total = productos.reduce((acc, p) => acc + (p.subtotal * p.iva_porcentaje) / 100, 0);
  return round2(total);
}

function normalizeProduct(value: unknown): ReceiptProduct | null {
  const record = asRecord(value);
  if (!record) return null;

  const nombre = asText(record.nombre);
  if (!nombre) return null; // without a name the line is not recoverable

  const subtotal = parseAmount(record.subtotal);
  const precioUnitario = parseAmount(record.precio_unitario);
  const cantidad = parseAmount(record.cantidad);

  // Repairs in order of reliability of the data present.
  const resolvedCantidad = cantidad !== null && cantidad !== 0 ? cantidad : 1;
  let resolvedPrecio = precioUnitario;
  let resolvedSubtotal = subtotal;

  if (resolvedPrecio === null && resolvedSubtotal !== null) {
    resolvedPrecio = resolvedSubtotal / resolvedCantidad; // may overflow to Infinity
  }
  if (resolvedSubtotal === null && resolvedPrecio !== null) {
    resolvedSubtotal = resolvedPrecio * resolvedCantidad; // may overflow to Infinity
  }
  // Repairs can produce Infinity/NaN: in that case the line is discarded.
  if (
    resolvedPrecio === null ||
    resolvedSubtotal === null ||
    !Number.isFinite(resolvedPrecio) ||
    !Number.isFinite(resolvedSubtotal)
  ) {
    return null;
  }

  const iva = parseAmount(record.iva_porcentaje);
  const codigo = asText(record.codigo_producto);

  const product: ReceiptProduct = {
    nombre,
    cantidad: resolvedCantidad,
    precio_unitario: resolvedPrecio,
    iva_porcentaje: iva ?? 0,
    subtotal: resolvedSubtotal,
  };
  if (codigo) product.codigo_producto = codigo;
  return product;
}

/**
 * Validates and normalizes the model response.
 *
 * - Fixes types (`"1.234,56"` → `1234.56`, `"$12"` → `12`).
 * - Discards irreparable lines and repairs missing totals from the lines when
 *   possible.
 * - Returns `null` when a reliable `ReceiptData` cannot be built (the endpoint
 *   then responds with 502).
 */
export function normalizeReceiptData(value: unknown): ReceiptData | null {
  const record = asRecord(value);
  if (!record) return null;

  const establecimiento = asText(record.establecimiento);
  if (!establecimiento) return null;

  if (!Array.isArray(record.productos)) return null;
  const productos = record.productos
    .map(normalizeProduct)
    .filter((product): product is ReceiptProduct => product !== null);
  // There were lines but none was recoverable: we do not trust the response.
  if (record.productos.length > 0 && productos.length === 0) return null;

  const impuestosReportados = parseAmount(record.impuestos_totales);
  const impuestos =
    impuestosReportados !== null ? impuestosReportados : deriveImpuestos(productos);
  // Derived sum is not finite (overflow): we cannot emit a valid number.
  if (impuestos === null) return null;

  const granTotalReportado = parseAmount(record.gran_total);
  const granTotal =
    granTotalReportado !== null
      ? granTotalReportado
      : round2(productos.reduce((acc, p) => acc + p.subtotal, 0) + impuestos);
  if (granTotal === null) return null;

  const fecha = asText(record.fecha);

  const receipt: ReceiptData = {
    establecimiento,
    productos,
    impuestos_totales: impuestos,
    gran_total: granTotal,
  };
  if (fecha) receipt.fecha = fecha;
  return receipt;
}
