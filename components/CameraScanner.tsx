"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { processReceipt, type ProcessError } from "../lib/api";
import type { ReceiptData } from "../lib/receipt";
import { AlertIcon, CameraIcon, CheckIcon, GalleryIcon, RefreshIcon, UploadIcon } from "./icons";
import ReceiptResult from "./ReceiptResult";
import {
  ICON_BUTTON,
  PRIMARY_BUTTON,
  PRIMARY_BUTTON_ON_DARK,
  SECONDARY_BUTTON,
  SECONDARY_BUTTON_ON_DARK,
} from "./ui";

/* ------------------------------- types ------------------------------- */

export type ImageSource = "camera" | "gallery";

/** Capture ready to be sent to the processing endpoint. */
export type ScannedImage = {
  /** Image in Base64 (`data:image/jpeg;base64,...`). */
  dataUrl: string;
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  source: ImageSource;
  capturedAt: number;
};

type CameraStatus = "starting" | "live" | "captured" | "error";

/** Processing stage of the captured image against `POST /api/process-receipt`. */
type ProcessStage = "idle" | "processing" | "done" | "failed";

type CameraErrorKind =
  | "unsupported"
  | "insecure"
  | "permission"
  | "not-found"
  | "in-use"
  | "constraints"
  | "unknown";

type CameraError = { kind: CameraErrorKind; detail: string | null };

type CameraEvent =
  | { type: "starting" }
  | { type: "live"; stream: MediaStream }
  | { type: "error"; error: CameraError };

type MutableRef<T> = { current: T };

/** Visual shape of the header status chip. */
type ChipConfig = { label: string; className: string; dot: string };

type CameraRefs = {
  session: MutableRef<number>;
  stream: MutableRef<MediaStream | null>;
  video: MutableRef<HTMLVideoElement | null>;
};

/* ------------------------------ messages ------------------------------ */

const ERROR_COPY: Record<CameraErrorKind, { title: string; hint: string }> = {
  unsupported: {
    title: "Tu navegador no admite la cámara",
    hint: "Actualiza el navegador o sube una imagen desde la galería para continuar.",
  },
  insecure: {
    title: "Conexión no segura",
    hint: "La cámara solo funciona en HTTPS o localhost. Abre la app con HTTPS e inténtalo de nuevo.",
  },
  permission: {
    title: "Permiso de cámara denegado",
    hint: "Permite el acceso a la cámara (icono de candado en la barra de direcciones) y vuelve a intentarlo.",
  },
  "not-found": {
    title: "No se detectó ninguna cámara",
    hint: "Este dispositivo no tiene una cámara disponible. Puedes subir una imagen desde la galería.",
  },
  "in-use": {
    title: "La cámara está en uso",
    hint: "Otra aplicación está usando la cámara. Ciérrala y reintenta.",
  },
  constraints: {
    title: "No se pudo abrir la cámara",
    hint: "No fue posible configurar el vídeo con la resolución solicitada. Reintenta o sube una imagen.",
  },
  unknown: {
    title: "No se pudo abrir la cámara",
    hint: "Se produjo un error inesperado. Reintenta o sube una imagen desde la galería.",
  },
};

/** Short labels for the status chip: full titles do not fit in the chip. */
const ERROR_CHIP_LABEL: Record<CameraErrorKind, string> = {
  unsupported: "No compatible",
  insecure: "Conexión insegura",
  permission: "Sin permiso",
  "not-found": "Sin cámara",
  "in-use": "Cámara ocupada",
  constraints: "Error de cámara",
  unknown: "Error de cámara",
};

/* --------------------- camera service (no React) --------------------- */

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function streamOf(video: HTMLVideoElement | null): MediaStream | null {
  const stream = video?.srcObject;
  return stream instanceof MediaStream ? stream : null;
}

function stopCameraStream(refs: CameraRefs): void {
  const stream = refs.stream.current ?? streamOf(refs.video.current);
  refs.stream.current = null;
  stopTracks(stream);
  const video = refs.video.current;
  if (video) video.srcObject = null;
}

function releaseStream(refs: CameraRefs, stream: MediaStream): void {
  stopTracks(stream);
  const video = refs.video.current;
  if (video && video.srcObject === stream) video.srcObject = null;
  if (refs.stream.current === stream) refs.stream.current = null;
}

function cameraRefsOf(
  session: MutableRef<number>,
  stream: MutableRef<MediaStream | null>,
  video: MutableRef<HTMLVideoElement | null>,
): CameraRefs {
  return { session, stream, video };
}

/** Stops the camera and cancels any in-flight open (prevents the LED staying on). */
function closeCamera(refs: CameraRefs): void {
  refs.session.current += 1;
  stopCameraStream(refs);
}

async function getMediaDevices(): Promise<MediaDevices | null> {
  if (typeof navigator === "undefined") return null;
  const devices = navigator.mediaDevices;
  return typeof devices?.getUserMedia === "function" ? devices : null;
}

function isRetryable(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return (
    name === "OverconstrainedError" ||
    name === "ConstraintNotSatisfiedError" ||
    name === "NotFoundError" ||
    name === "TypeError"
  );
}

/**
 * Rear 1920x1080 as ideal (mobile) and, if the device does not support it,
 * retries with any available camera.
 */
async function requestStream(devices: MediaDevices): Promise<MediaStream> {
  const attempts: MediaStreamConstraints[] = [
    {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    },
    { audio: false, video: true },
  ];

  let lastError: unknown = null;
  for (const constraints of attempts) {
    try {
      return await devices.getUserMedia(constraints);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error)) break;
    }
  }
  throw lastError ?? new Error("unknown");
}

function describeMediaError(error: unknown): CameraError {
  const name = error instanceof Error ? error.name : "unknown";
  const detail = name === "unknown" ? (error instanceof Error ? null : String(error)) : name;

  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return { kind: "permission", detail };
    case "NotFoundError":
    case "DevicesNotFoundError":
      return { kind: "not-found", detail };
    case "NotReadableError":
    case "TrackStartError":
      return { kind: "in-use", detail };
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
    case "TypeError":
      return { kind: "constraints", detail };
    default:
      return { kind: "unknown", detail };
  }
}

/**
 * Opens the camera and notifies via `emit` (callbacks defined in the component).
 * Every call to `navigator.mediaDevices` happens inside this async flow,
 * started from `useEffect`, so it does not affect server prerendering.
 */
async function openCamera(refs: CameraRefs, emit: (event: CameraEvent) => void): Promise<void> {
  const token = refs.session.current + 1;
  refs.session.current = token;
  stopCameraStream(refs);
  emit({ type: "starting" });

  if (typeof window !== "undefined" && window.isSecureContext === false) {
    emit({ type: "error", error: { kind: "insecure", detail: "window.isSecureContext=false" } });
    return;
  }

  const devices = await getMediaDevices();
  if (token !== refs.session.current) return;

  if (!devices) {
    emit({ type: "error", error: { kind: "unsupported", detail: "navigator.mediaDevices" } });
    return;
  }

  try {
    const stream = await requestStream(devices);
    if (token !== refs.session.current) {
      releaseStream(refs, stream);
      return;
    }

    refs.stream.current = stream;
    const video = refs.video.current;
    if (video) {
      video.srcObject = stream;
      video.muted = true;
      await video.play().catch(() => undefined);
    }

    if (token !== refs.session.current) {
      releaseStream(refs, stream);
      return;
    }

    emit({ type: "live", stream });
  } catch (error) {
    if (token !== refs.session.current) return;
    emit({ type: "error", error: describeMediaError(error) });
  }
}

/* ------------------------------- utilities ------------------------------- */

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("read error"));
    reader.readAsDataURL(blob);
  });
}

function readImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = document.createElement("img");
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("invalid image"));
    img.src = dataUrl;
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------- presentation ------------------------------- */

const STATUS_CHIP: Record<CameraStatus, ChipConfig> = {
  starting: {
    label: "Preparando",
    className: "bg-amber-50 text-amber-800 ring-amber-300/70",
    dot: "bg-amber-500",
  },
  live: {
    label: "En vivo",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-300/70",
    dot: "bg-emerald-500 animate-pulse",
  },
  captured: {
    label: "Foto lista",
    className: "bg-accent/10 text-accent ring-accent/30",
    dot: "bg-accent",
  },
  error: {
    label: "Error de cámara",
    className: "bg-red-50 text-red-700 ring-red-300/70",
    dot: "bg-red-500",
  },
};

/** The processing stage takes priority over the camera chip. */
const STAGE_CHIP: Record<ProcessStage, ChipConfig | null> = {
  idle: null,
  processing: {
    label: "Procesando",
    className: "bg-accent/10 text-accent ring-accent/30",
    dot: "bg-accent animate-pulse",
  },
  done: {
    label: "Datos listos",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-300/70",
    dot: "bg-emerald-500",
  },
  failed: {
    label: "Error de procesado",
    className: "bg-red-50 text-red-700 ring-red-300/70",
    dot: "bg-red-500",
  },
};

function StatusChip({
  status,
  stage,
  error,
}: {
  status: CameraStatus;
  stage: ProcessStage;
  error: CameraError | null;
}) {
  const fallback = { ...STATUS_CHIP[status] };
  if (status === "error" && error) fallback.label = ERROR_CHIP_LABEL[error.kind];
  const config = STAGE_CHIP[stage] ?? fallback;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${config.className}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${config.dot}`} />
      {config.label}
    </span>
  );
}

function FrameBrackets() {
  const corner = "absolute h-7 w-7 border-accent-bright/90";
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-4 drop-shadow-[0_1px_2px_rgba(0,0,0,0.7)] sm:inset-5"
    >
      <span className={`${corner} top-0 left-0 rounded-tl-md border-t-2 border-l-2`} />
      <span className={`${corner} top-0 right-0 rounded-tr-md border-t-2 border-r-2`} />
      <span className={`${corner} bottom-0 left-0 rounded-bl-md border-b-2 border-l-2`} />
      <span className={`${corner} bottom-0 right-0 rounded-br-md border-b-2 border-r-2`} />
    </div>
  );
}

/* --------------------------------- component --------------------------------- */

export default function CameraScanner() {
  const [status, setStatus] = useState<CameraStatus>("starting");
  const [error, setError] = useState<CameraError | null>(null);
  const [image, setImage] = useState<ScannedImage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [stage, setStage] = useState<ProcessStage>("idle");
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [processError, setProcessError] = useState<ProcessError | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Identifies the latest submission so stale responses can be discarded. */
  const requestRef = useRef(0);

  const emit = useCallback((event: CameraEvent) => {
    if (event.type === "starting") {
      setStatus("starting");
      setError(null);
      setNotice(null);
      return;
    }
    if (event.type === "live") {
      setStatus("live");
      setError(null);
      return;
    }
    setStatus("error");
    setError(event.error);
  }, []);

  const stopCamera = useCallback(() => {
    closeCamera(cameraRefsOf(sessionRef, streamRef, videoRef));
  }, []);

  const startCamera = useCallback(() => {
    void openCamera(cameraRefsOf(sessionRef, streamRef, videoRef), emit);
  }, [emit]);

  /**
   * Sends the image to the processing endpoint and manages the UI states.
   * Only one request is in flight: if another image arrives, the previous
   * response is discarded to avoid showing data from a photo that is no longer the current one.
   */
  const sendForProcessing = useCallback(async (scanned: ScannedImage) => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setStage("processing");
    setReceipt(null);
    setProcessError(null);

    try {
      const outcome = await processReceipt(scanned.dataUrl);
      if (requestId !== requestRef.current) return;
      if (outcome.ok) {
        setReceipt(outcome.receipt);
        setStage("done");
      } else {
        setProcessError(outcome.error);
        setStage("failed");
      }
    } catch {
      // Redundant with the internal handling, but guarantees leaving the loading state.
      if (requestId !== requestRef.current) return;
      setProcessError({
        status: null,
        message: "Se produjo un error inesperado. Inténtalo de nuevo.",
        detail: null,
      });
      setStage("failed");
    }
    // No `finally`: if the response is stale we do not touch any state.
  }, []);

  /** Resends the SAME image without capturing again. */
  const retryProcessing = useCallback(() => {
    if (image) void sendForProcessing(image);
  }, [image, sendForProcessing]);

  // Startup on mount: requests permission and shows the video. Cleanup handles the tracks.
  useEffect(() => {
    const refs = cameraRefsOf(sessionRef, streamRef, videoRef);
    void openCamera(refs, (event) => emit(event));
    return () => closeCamera(refs);
  }, [emit]);

  const capturePhoto = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      setNotice("La cámara aún no está lista. Espera un momento y vuelve a intentarlo.");
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      setNotice("Este navegador no permite generar la imagen desde la cámara.");
      return;
    }

    // The <video> frame already arrives oriented from the browser: it is copied 1:1.
    canvas.width = width;
    canvas.height = height;
    context.drawImage(video, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.92),
    );
    if (!blob) {
      setNotice("No se pudo generar la captura. Inténtalo de nuevo o sube una imagen.");
      return;
    }

    let dataUrl: string;
    try {
      dataUrl = await blobToDataUrl(blob);
    } catch {
      setNotice("No se pudo leer la captura. Inténtalo de nuevo o sube una imagen.");
      return;
    }

    const scanned: ScannedImage = {
      dataUrl,
      blob,
      mimeType: blob.type,
      width,
      height,
      source: "camera",
      capturedAt: Date.now(),
    };
    setImage(scanned);
    setNotice(null);
    setStatus("captured");
    stopCamera();
    void sendForProcessing(scanned);
  }, [sendForProcessing, stopCamera]);

  const retake = useCallback(() => {
    requestRef.current += 1; // invalidates any response that is still in flight
    setImage(null);
    setNotice(null);
    setReceipt(null);
    setProcessError(null);
    setStage("idle");
    startCamera();
  }, [startCamera]);

  const openGallery = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.target;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;

      if (!file.type.startsWith("image/")) {
        setNotice("Ese archivo no es una imagen. Selecciona una foto JPG, PNG o similar.");
        return;
      }

      try {
        const dataUrl = await blobToDataUrl(file);
        const { width, height } = await readImageSize(dataUrl);
        const scanned: ScannedImage = {
          dataUrl,
          blob: file,
          mimeType: file.type,
          width,
          height,
          source: "gallery",
          capturedAt: Date.now(),
        };
        setImage(scanned);
        setNotice(null);
        setStatus("captured");
        stopCamera();
        void sendForProcessing(scanned);
      } catch {
        setNotice("No se pudo leer la imagen seleccionada. Prueba con otro archivo.");
      }
    },
    [sendForProcessing, stopCamera],
  );

  const announcement =
    stage === "processing"
      ? "Procesando la imagen con IA. Puede tardar hasta un minuto."
      : stage === "done"
        ? "Datos del tique extraídos. Revisa el resultado."
        : stage === "failed"
          ? `Error al procesar la imagen: ${processError ? processError.message : ""}`
          : status === "starting"
            ? "Solicitando acceso a la cámara."
            : status === "live"
              ? "Cámara en vivo. Pulsa el botón de captura para hacer la foto."
              : status === "captured"
                ? "Foto capturada. Puedes repetirla o elegir otra imagen."
                : `Error de cámara: ${error ? ERROR_COPY[error.kind].title : ""}`;

  const isProcessing = stage === "processing";
  const showResult = stage === "done" && receipt !== null;

  const heading = showResult
    ? { title: "Datos del tique", subtitle: "Revisa la información extraída antes de continuar." }
    : isProcessing
      ? { title: "Procesando la foto", subtitle: "Estamos leyendo el documento con IA." }
      : { title: "Captura el documento", subtitle: "Encuadra el tique o la factura dentro del marco." };

  const stats = image
    ? [
        { label: "Origen", value: image.source === "camera" ? "Cámara" : "Galería" },
        { label: "Dimensiones", value: `${image.width}×${image.height}` },
        { label: "Peso", value: formatBytes(image.blob.size) },
      ]
    : [];

  return (
    <section aria-labelledby="scanner-heading" className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            id="scanner-heading"
            className="text-base font-semibold tracking-tight text-foreground sm:text-lg"
          >
            {heading.title}
          </h1>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{heading.subtitle}</p>
        </div>
        <StatusChip status={status} stage={stage} error={error} />
      </div>

      <div
        className={`relative isolate max-h-[62dvh] min-h-[320px] flex-1 overflow-hidden rounded-3xl border border-line bg-black shadow-viewfinder ${
          showResult ? "hidden" : ""
        }`}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          aria-label="Vista previa en vivo de la cámara"
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
            status === "live" ? "opacity-100" : "opacity-0"
          }`}
        />

        {status === "captured" && image ? (
          <Image
            src={image.dataUrl}
            alt="Vista previa de la imagen capturada"
            width={image.width}
            height={image.height}
            unoptimized
            className="absolute inset-0 h-full w-full bg-black object-contain"
          />
        ) : null}

        <div aria-hidden className="doc-grid pointer-events-none absolute inset-0 opacity-70" />
        <FrameBrackets />
        {status === "live" ? <span aria-hidden className="scan-line" /> : null}

        {status === "starting" ? (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/70 px-8 text-center">
            <CameraIcon className="h-8 w-8 animate-pulse text-accent-bright" />
            <p className="text-sm font-medium text-zinc-100">Solicitando acceso a la cámara…</p>
            <p className="text-xs leading-5 text-zinc-400">
              Acepta la petición del navegador para ver la vista previa en vivo.
            </p>
          </div>
        ) : null}

        {isProcessing ? (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-black/85 px-8 text-center">
            <div aria-hidden className="doc-grid pointer-events-none absolute inset-0 opacity-70" />
            <span aria-hidden className="scan-line" />
            <span
              aria-hidden
              className="h-9 w-9 animate-spin rounded-full border-[3px] border-white/20 border-t-accent-bright"
            />
            <div className="space-y-1.5">
              <p className="text-sm font-semibold text-zinc-50">
                Procesando con IA… puede tardar hasta ~1 min
              </p>
              <p className="mx-auto max-w-[19rem] text-xs leading-5 text-zinc-400">
                Estamos leyendo el tique. No cierres esta pantalla mientras terminamos.
              </p>
            </div>
            <div
              role="progressbar"
              aria-label="Progreso del procesado"
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-1 w-44 overflow-hidden rounded-full bg-white/10"
            >
              <span aria-hidden className="block h-full w-1/3 animate-pulse rounded-full bg-accent-bright" />
            </div>
          </div>
        ) : null}

        {status === "error" && error ? (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/80 px-6 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-full bg-red-400/10 text-red-300 ring-1 ring-red-400/30">
              <AlertIcon className="h-5 w-5" />
            </span>
            <div className="space-y-1.5">
              <p className="text-sm font-semibold text-zinc-50">{ERROR_COPY[error.kind].title}</p>
              <p className="mx-auto max-w-[19rem] text-xs leading-5 text-zinc-400">
                {ERROR_COPY[error.kind].hint}
              </p>
              {error.detail ? (
                <p className="pt-1 font-mono text-[10px] tracking-wide text-zinc-400">
                  {error.detail}
                </p>
              ) : null}
            </div>
            <div className="flex w-full max-w-[17rem] flex-col gap-2">
              <button type="button" onClick={openGallery} className={PRIMARY_BUTTON_ON_DARK}>
                <UploadIcon className="h-4 w-4" />
                Subir imagen desde la galería
              </button>
              <button type="button" onClick={startCamera} className={SECONDARY_BUTTON_ON_DARK}>
                <RefreshIcon className="h-4 w-4" />
                Reintentar cámara
              </button>
            </div>
          </div>
        ) : null}

        {status === "live" ? (
          <div className="absolute inset-x-0 bottom-0 z-20 grid grid-cols-[1fr_auto_1fr] items-end gap-3 bg-gradient-to-t from-black/90 via-black/45 to-transparent px-5 pt-14 pb-5">
            <button
              type="button"
              onClick={openGallery}
              aria-label="Subir imagen desde la galería"
              className={ICON_BUTTON}
            >
              <GalleryIcon className="h-5 w-5" />
            </button>

            <div className="flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={() => void capturePhoto()}
                aria-label="Capturar foto"
                className="group relative grid h-[72px] w-[72px] place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-bright"
              >
                <span
                  aria-hidden
                  className="absolute inset-0 rounded-full border-[3px] border-white/85 transition group-active:scale-95"
                />
                <span
                  aria-hidden
                  className="absolute inset-[7px] rounded-full bg-white transition group-hover:bg-zinc-100 group-active:scale-90"
                />
              </button>
              <span className="text-[10px] font-medium tracking-[0.14em] text-zinc-300 uppercase">
                Capturar
              </span>
            </div>

            <span aria-hidden className="h-11 w-11 justify-self-end" />
          </div>
        ) : null}

        {status === "captured" && image ? (
          <div className="absolute inset-x-0 bottom-0 z-20 grid grid-cols-[1fr_auto_1fr] items-center gap-3 bg-gradient-to-t from-black/90 via-black/45 to-transparent px-5 pt-14 pb-5">
            <button
              type="button"
              onClick={retake}
              disabled={isProcessing}
              aria-label="Repetir la foto y retomar la cámara"
              className={ICON_BUTTON}
            >
              <RefreshIcon className="h-5 w-5" />
            </button>

            <div className="text-center">
              {isProcessing ? (
                <p className="flex items-center justify-center gap-1.5 text-xs font-semibold text-accent-bright">
                  <span
                    aria-hidden
                    className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-accent-bright"
                  />
                  Procesando…
                </p>
              ) : (
                <p className="flex items-center justify-center gap-1.5 text-xs font-semibold text-emerald-300">
                  <CheckIcon className="h-4 w-4" />
                  Foto capturada
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={openGallery}
              disabled={isProcessing}
              aria-label="Elegir otra imagen de la galería"
              className={`${ICON_BUTTON} justify-self-end`}
            >
              <GalleryIcon className="h-5 w-5" />
            </button>
          </div>
        ) : null}
      </div>

      {notice ? (
        <p
          role="alert"
          className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800"
        >
          {notice}
        </p>
      ) : null}

      {showResult && receipt ? (
        <ReceiptResult receipt={receipt} onScanAnother={retake} />
      ) : stage === "failed" && processError ? (
        <div className="flex flex-col gap-3">
          <div
            role="alert"
            className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3.5 text-xs leading-5 text-red-800"
          >
            <p className="flex items-start gap-2 text-sm font-semibold text-red-900">
              <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              No se pudo procesar la imagen
            </p>
            <p className="mt-1.5 text-red-800">{processError.message}</p>
            {processError.detail ? (
              <p className="mt-1.5 break-words font-mono text-[10px] leading-4 text-red-700">
                {processError.detail}
              </p>
            ) : null}
            {processError.status !== null ? (
              <p className="mt-1.5 text-[10px] tracking-wide text-red-700 uppercase">
                HTTP {processError.status}
              </p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <button type="button" onClick={retryProcessing} className={PRIMARY_BUTTON}>
              <RefreshIcon className="h-4 w-4" />
              Reintentar con la misma imagen
            </button>
            <button type="button" onClick={retake} className={SECONDARY_BUTTON}>
              <CameraIcon className="h-4 w-4" />
              Repetir la foto
            </button>
          </div>
        </div>
      ) : status === "captured" && image ? (
        <dl className="grid grid-cols-3 rounded-2xl border border-line bg-surface">
          {stats.map((stat, index) => (
            <div
              key={stat.label}
              className={`px-3 py-2.5 ${index > 0 ? "border-l border-line" : ""}`}
            >
              <dt className="text-[10px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
                {stat.label}
              </dt>
              <dd className="mt-1 truncate font-mono text-xs text-foreground">{stat.value}</dd>
            </div>
          ))}
        </dl>
      ) : notice ? null : (
        <p className="px-1 text-xs leading-5 text-muted-foreground">
          {status === "error"
            ? "La imagen se envía a la API para extraer los datos con IA."
            : "Consejo: buena luz, documento plano y sin sombras sobre el tique."}
        </p>
      )}

      <canvas ref={canvasRef} aria-hidden className="hidden" />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => void handleFileChange(event)}
      />

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}
