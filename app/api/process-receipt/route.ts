import {
  RECEIPT_JSON_SCHEMA,
  normalizeReceiptData,
  type ReceiptData,
} from "@/lib/receipt";

/* -------------------------------------------------------------------------- */
/*                                 Configuration                               */
/* -------------------------------------------------------------------------- */

/**
 * Body contract (JSON):
 *
 * ```json
 * { "image": "data:image/jpeg;base64,..." | "<raw base64>", "mimeType": "image/jpeg" }
 * ```
 *
 * - `image` (required): full data URL or raw base64.
 * - `mimeType` (optional): only needed with raw base64; defaults to
 *   `image/jpeg`.
 *
 * Responses:
 * - `200` → `ReceiptData` (validated and normalized JSON).
 * - `400` → `{ error }` malformed body / missing or invalid image.
 * - `413` → `{ error }` payload too large.
 * - `500` → `{ error }` `OPENROUTER_API_KEY` not configured.
 * - `502` → `{ error }` OpenRouter failure or unrecoverable response.
 * - `504` → `{ error }` timeout calling OpenRouter.
 *
 * Environment variables (see `.env.example`):
 * - `OPENROUTER_API_KEY` (required) → without it the response is 500.
 * - `OPENROUTER_MODEL` (optional) → default model `DEFAULT_OPENROUTER_MODEL`.
 * - `OPENROUTER_BASE_URL` (optional) → alternative OpenRouter-compatible endpoint.
 */
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024; // 8 MB of JSON body
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB of decoded image

const DEFAULT_OPENROUTER_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
/** Default free vision model; it can be replaced with `OPENROUTER_MODEL`. */
const DEFAULT_OPENROUTER_MODEL = "dots-studio/dots-3-note-preview:free";
/**
 * Total time budget, shared by ALL the fallback attempts (request + reading
 * the response body). It is smaller than `maxDuration` so that the platform
 * does not kill the invocation before we can respond 504.
 */
const OPENROUTER_TIMEOUT_MS = 50_000;
const MAX_OUTPUT_TOKENS = 4096;

export const maxDuration = 60;

/* -------------------------------------------------------------------------- */
/*                                   Prompts                                   */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROMPT = [
  "Eres un extractor de datos de tiques y facturas en español.",
  "Responde SOLO con un objeto JSON válido (sin markdown, sin comentarios, sin texto antes o después) con esta forma:",
  '  { "establecimiento": string, "fecha": string, "productos": [{ "codigo_producto": string, "nombre": string, "cantidad": number, "precio_unitario": number, "iva_porcentaje": number, "subtotal": number }], "impuestos_totales": number, "gran_total": number }',
  "Reglas:",
  '- `establecimiento`: nombre del comercio; `fecha`: en formato "AAAA-MM-DD" si es visible, si no cadena vacía "".',
  '- `codigo_producto`: código/SKU impreso, si no existe cadena vacía "".',
  "- Todos los números deben ser JSON numérico: sin símbolos de moneda (€, $), sin separadores de miles y con punto decimal (1234.56, no \"1.234,56\").",
  "- `iva_porcentaje` es un porcentaje numérico: 21 significa 21%.",
  "- `subtotal` es `cantidad × precio_unitario`; `gran_total` es lo que se paga en caja.",
  "- No inventes datos que no se lean en la imagen.",
].join("\n");

const USER_PROMPT = "Extrae los datos de este tique/factura.";

/* -------------------------------------------------------------------------- */
/*                              Auxiliary structures                           */
/* -------------------------------------------------------------------------- */

type JsonRecord = Record<string, unknown>;

/** `response_format` strategies, from most to least strict. */
type Strategy = "json_schema" | "json_object" | "none";

const STRATEGIES: readonly Strategy[] = ["json_schema", "json_object", "none"];

type CallResult =
  | { kind: "content"; content: string; finishReason: string | null }
  | { kind: "format_unsupported"; status: number; detail: string }
  | { kind: "timeout" }
  | { kind: "network"; detail: string }
  | { kind: "auth"; status: number; detail: string }
  | { kind: "rate_limited"; detail: string }
  | { kind: "upstream"; status: number; detail: string };

function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** Truncates and neutralizes any base64 that might sneak into an error message. */
function safeDetail(raw: string): string {
  const withoutBase64 = raw.replace(/[A-Za-z0-9+/]{200,}={0,2}/g, "[base64]");
  return withoutBase64.replace(/\s+/g, " ").trim().slice(0, 300);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* -------------------------------------------------------------------------- */
/*                              Reading the body                               */
/* -------------------------------------------------------------------------- */

type ReadResult = { ok: true; text: string } | { ok: false; status: number; error: string };

/**
 * Reads the body enforcing the size limit: checks `Content-Length` (if it
 * exists) and also stops the streaming read so giant payloads are never
 * buffered. Returns 413 if the limit is exceeded.
 */
async function readBodyWithLimit(request: Request): Promise<ReadResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > MAX_JSON_BODY_BYTES) {
      return {
        ok: false,
        status: 413,
        error: `Payload demasiado grande: el body supera el límite de ${MAX_JSON_BODY_BYTES} bytes.`,
      };
    }
  }

  let text = "";
  try {
    const stream = request.body;
    if (stream) {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let total = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = chunk.value;
        total += value.byteLength;
        if (total > MAX_JSON_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          return {
            ok: false,
            status: 413,
            error: `Payload demasiado grande: el body supera el límite de ${MAX_JSON_BODY_BYTES} bytes.`,
          };
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } else {
      text = await request.text();
    }
  } catch {
    return { ok: false, status: 400, error: "No se pudo leer el cuerpo de la petición." };
  }

  return { ok: true, text };
}

type ParsedRequest = { ok: true; dataUrl: string } | { ok: false; status: number; error: string };

/** Validates the body and returns the image as a data URL ready for the model. */
async function parseImageRequest(request: Request): Promise<ParsedRequest> {
  const read = await readBodyWithLimit(request);
  if (!read.ok) return read;

  if (read.text.trim() === "") {
    return { ok: false, status: 400, error: "El body de la petición está vacío." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { ok: false, status: 400, error: "El body no es JSON válido." };
  }

  if (!isRecord(parsed)) {
    return { ok: false, status: 400, error: 'El body debe ser un objeto con el campo "image".' };
  }

  const image = parsed.image;
  if (image === undefined || image === null) {
    return {
      ok: false,
      status: 400,
      error: 'Falta la imagen: envía "image" como data URL (data:image/jpeg;base64,…) o base64 crudo.',
    };
  }
  if (typeof image !== "string" || image.trim() === "") {
    return { ok: false, status: 400, error: 'El campo "image" debe ser una cadena no vacía.' };
  }

  const mimeType = parsed.mimeType;
  if (mimeType !== undefined && typeof mimeType !== "string") {
    return { ok: false, status: 400, error: 'El campo "mimeType" debe ser una cadena.' };
  }

  return buildDataUrl(image.trim(), typeof mimeType === "string" ? mimeType : undefined);
}

/** Normalizes a data URL or raw base64 to `data:<mime>;base64,<data>`. */
function buildDataUrl(image: string, mimeType: string | undefined): ParsedRequest {
  let base64 = image;
  let mime = mimeType?.trim() ?? "";

  if (/^data:/i.test(image)) {
    const commaIndex = image.indexOf(",");
    if (commaIndex === -1) {
      return { ok: false, status: 400, error: "La data URL no contiene datos tras la coma." };
    }
    const header = image.slice("data:".length, commaIndex);
    const parts = header.split(";");
    if (parts[parts.length - 1].toLowerCase() !== "base64") {
      return { ok: false, status: 400, error: 'La data URL debe usar el formato "data:<mime>;base64,<datos>".' };
    }
    const declaredMime = parts[0];
    if (declaredMime.includes("/")) mime = declaredMime;
    base64 = image.slice(commaIndex + 1);
  }

  const compact = base64.replace(/\s+/g, "");
  if (compact === "") {
    return { ok: false, status: 400, error: "La imagen está vacía." };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    return { ok: false, status: 400, error: 'El campo "image" no es base64 válido.' };
  }
  if (compact.length % 4 !== 0) {
    return { ok: false, status: 400, error: 'El campo "image" no es base64 válido (longitud incorrecta).' };
  }

  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  const decodedBytes = Math.floor((compact.length * 3) / 4) - padding;
  if (decodedBytes > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Payload demasiado grande: la imagen supera los ${MAX_IMAGE_BYTES} bytes.`,
    };
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9.+-]+$/.test(mime)) {
    mime = "image/jpeg";
  }

  return { ok: true, dataUrl: `data:${mime};base64,${compact}` };
}

/* -------------------------------------------------------------------------- */
/*                              OpenRouter call                                */
/* -------------------------------------------------------------------------- */

function buildPayload(model: string, dataUrl: string, strategy: Strategy): JsonRecord {
  const payload: JsonRecord = {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    // Desactiva el razonamiento: con imagen + json_schema estricto este modelo
    // tarda >30 s razonando y supera el timeout de 50 s (verificado: 6 s sin
    // razonamiento vs >30 s con él).
    reasoning: { enabled: false },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: USER_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  };

  // Strategy 1: strict structured outputs. If the provider does not support
  // them (400/422) we fall back to `json_object` and, as a last resort, to
  // prompt-only JSON.
  if (strategy === "json_schema") {
    payload.response_format = {
      type: "json_schema",
      json_schema: { name: "receipt_data", strict: true, schema: RECEIPT_JSON_SCHEMA },
    };
  } else if (strategy === "json_object") {
    payload.response_format = { type: "json_object" };
  }

  return payload;
}

async function extractErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return "";
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (typeof error === "string") return safeDetail(error);
      if (isRecord(error) && typeof error.message === "string") return safeDetail(error.message);
      if (typeof parsed.message === "string") return safeDetail(parsed.message);
    }
    return safeDetail(text);
  } catch {
    return "";
  }
}

/**
 * Chat completions endpoint.
 *
 * `OPENROUTER_BASE_URL` (optional) allows replacing the endpoint with another
 * compatible one; by default the OpenRouter one is used. It is read at runtime
 * so that the override also works after a build.
 */
function completionsUrl(): string {
  return process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_COMPLETIONS_URL;
}

/**
 * A single attempt against OpenRouter limited by `timeoutMs`, the time
 * remaining of the shared deadline.
 *
 * The `AbortController` `signal` covers both the request and reading the
 * response body (`extractErrorDetail`/`response.json()`), so no phase can
 * exceed the total budget.
 */
async function callOpenRouter(
  model: string,
  apiKey: string,
  dataUrl: string,
  strategy: Strategy,
  timeoutMs: number,
): Promise<CallResult> {
  if (timeoutMs <= 0) return { kind: "timeout" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(completionsUrl(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "scanner-app",
        },
        body: JSON.stringify(buildPayload(model, dataUrl, strategy)),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) return { kind: "timeout" };
      return {
        kind: "network",
        detail: safeDetail(error instanceof Error ? error.message : String(error)),
      };
    }

    if (!response.ok) {
      const detail = await extractErrorDetail(response);
      if (controller.signal.aborted) return { kind: "timeout" };
      if (response.status === 401 || response.status === 403) {
        return { kind: "auth", status: response.status, detail };
      }
      if (response.status === 429) {
        return { kind: "rate_limited", detail };
      }
      if ((response.status === 400 || response.status === 422) && strategy !== "none") {
        return { kind: "format_unsupported", status: response.status, detail };
      }
      return { kind: "upstream", status: response.status, detail };
    }

    let payload: JsonRecord;
    try {
      payload = (await response.json()) as JsonRecord;
    } catch {
      if (controller.signal.aborted) return { kind: "timeout" };
      return { kind: "upstream", status: response.status, detail: "respuesta no válida de OpenRouter" };
    }

    const choices: unknown = payload.choices;
    const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
    const message = isRecord(first) ? first.message : undefined;
    const rawContent = isRecord(message) ? message.content : undefined;

    let content = "";
    if (typeof rawContent === "string") {
      content = rawContent;
    } else if (Array.isArray(rawContent)) {
      content = rawContent
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("");
    }

    const finishReason =
      isRecord(first) && typeof first.finish_reason === "string" ? first.finish_reason : null;

    return { kind: "content", content: content.trim(), finishReason };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/*                              Response parsing                               */
/* -------------------------------------------------------------------------- */

/** Extracts the first JSON object from the content (in case the model adds text or fences). */
function parseModelJson(content: string): { ok: true; value: unknown } | { ok: false } {
  if (content === "") return { ok: false };

  const unfenced = content
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  const candidate = start !== -1 && end > start ? unfenced.slice(start, end + 1) : unfenced;

  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch {
    return { ok: false };
  }
}

function upstreamErrorResponse(result: CallResult, model: string): Response {
  switch (result.kind) {
    case "timeout":
      return errorResponse(
        504,
        `Tiempo de espera agotado (${OPENROUTER_TIMEOUT_MS} ms) al llamar a OpenRouter con el modelo ${model}.`,
      );
    case "network":
      return errorResponse(
        502,
        `No se pudo contactar con OpenRouter${result.detail ? `: ${result.detail}` : " (red no disponible)"}.`,
      );
    case "auth":
      return errorResponse(
        502,
        `OpenRouter rechazó la autenticación (HTTP ${result.status}). Revisa la variable OPENROUTER_API_KEY.${
          result.detail ? ` ${result.detail}` : ""
        }`,
      );
    case "rate_limited":
      return errorResponse(
        502,
        `OpenRouter limitó la tasa de peticiones (HTTP 429). Inténtalo más tarde.${
          result.detail ? ` ${result.detail}` : ""
        }`,
      );
    case "upstream":
      return errorResponse(
        502,
        `OpenRouter respondió con HTTP ${result.status}${result.detail ? `: ${result.detail}` : "."}`,
      );
    case "format_unsupported":
      return errorResponse(
        502,
        `OpenRouter rechazó el formato estructurado (HTTP ${result.status})${
          result.detail ? `: ${result.detail}` : "."
        }`,
      );
    default:
      return errorResponse(502, "Error desconocido al procesar la imagen con OpenRouter.");
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Handler                                    */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/process-receipt`
 *
 * Receives a base64 image and returns the receipt data extracted by an
 * OpenRouter vision model, already validated and normalized.
 */
export async function POST(request: Request): Promise<Response> {
  const parsedRequest = await parseImageRequest(request);
  if (!parsedRequest.ok) {
    return errorResponse(parsedRequest.status, parsedRequest.error);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return errorResponse(
      500,
      "Falta OPENROUTER_API_KEY: configura la clave de OpenRouter en .env.local (ver .env.example).",
    );
  }

  const model = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
  const { dataUrl } = parsedRequest;

  let lastIssue = "";

  // Shared deadline: all the fallback attempts (and reading their bodies) add
  // up to at most `OPENROUTER_TIMEOUT_MS`, below `maxDuration`.
  const deadline = Date.now() + OPENROUTER_TIMEOUT_MS;

  for (let index = 0; index < STRATEGIES.length; index += 1) {
    const strategy = STRATEGIES[index];
    const isLast = index === STRATEGIES.length - 1;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.error(`[process-receipt] presupuesto de tiempo agotado antes del intento "${strategy}".`);
      return upstreamErrorResponse({ kind: "timeout" }, model);
    }

    const result = await callOpenRouter(model, apiKey, dataUrl, strategy, remaining);

    if (result.kind !== "content") {
      if (result.kind === "format_unsupported" && !isLast) {
        lastIssue = `response_format no soportado por ${model} (HTTP ${result.status})`;
        console.warn(`[process-receipt] fallback de response_format (${strategy}): ${lastIssue}`);
        continue;
      }
      console.error(
        `[process-receipt] OpenRouter error (${strategy}, modelo ${model}): ${result.kind} status=${
          "status" in result ? result.status : "n/a"
        } detail=${"detail" in result ? result.detail : ""}`,
      );
      return upstreamErrorResponse(result, model);
    }

    const parsed = parseModelJson(result.content);
    const receipt: ReceiptData | null = parsed.ok ? normalizeReceiptData(parsed.value) : null;

    if (receipt) {
      return Response.json(receipt);
    }

    lastIssue = parsed.ok
      ? "el JSON no cumple el esquema ReceiptData"
      : result.content === ""
        ? "el modelo no devolvió contenido"
        : `el modelo no devolvió JSON parseable${result.finishReason === "length" ? " (respuesta truncada)" : ""}`;

    if (!isLast) {
      console.warn(`[process-receipt] reintentando con otra estrategia (${strategy}): ${lastIssue}`);
      continue;
    }
  }

  return errorResponse(
    502,
    `La IA no devolvió datos de tique utilizables (${lastIssue || "respuesta desconocida"}).`,
  );
}
