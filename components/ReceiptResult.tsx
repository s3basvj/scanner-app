"use client";

import { useMemo } from "react";
import type { ReceiptData, ReceiptProduct } from "../lib/receipt";
import { PRIMARY_BUTTON } from "./ui";

/**
 * Currency of the displayed amounts: Costa Rican colón by default
 * (the app is in Costa Rican Spanish). Change it to `"USD"` if
 * receipts are issued in dollars.
 */
const CURRENCY = "CRC";

const LOCALE = "es-CR";

const money = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: CURRENCY,
  minimumFractionDigits: 2,
});

const quantity = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });

function formatMoney(value: number): string {
  return money.format(value);
}

/** `YYYY-MM-DD` → local date (avoids the UTC offset of `new Date("…")`). */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

function formatDate(value: string): string {
  const parts = ISO_DATE.exec(value);
  if (parts) {
    const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
    return new Intl.DateTimeFormat(LOCALE, { dateStyle: "long" }).format(date);
  }
  // Any other format: reformatted only if the browser understands it;
  // otherwise shown as-is, so no information is lost.
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: "long" }).format(parsed);
}

function ProductRow({ product }: { product: ReceiptProduct }) {
  const showCode = product.codigo_producto !== undefined && product.codigo_producto !== "";

  return (
    <li className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm leading-5 font-medium break-words text-foreground">{product.nombre}</p>
        <p className="mt-1 text-xs leading-4 text-muted-foreground">
          {quantity.format(product.cantidad)} × {formatMoney(product.precio_unitario)} · IVA{" "}
          {quantity.format(product.iva_porcentaje)}%
        </p>
        {showCode ? (
          <p className="mt-0.5 font-mono text-[10px] tracking-wide break-all text-muted-foreground">
            {product.codigo_producto}
          </p>
        ) : null}
      </div>
      <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
        {formatMoney(product.subtotal)}
      </p>
    </li>
  );
}

export default function ReceiptResult({
  receipt,
  onScanAnother,
}: {
  receipt: ReceiptData;
  onScanAnother: () => void;
}) {
  const json = useMemo(() => JSON.stringify(receipt, null, 2), [receipt]);
  const products = receipt.productos;

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-3xl border border-line bg-surface shadow-sm">
        <div className="border-b border-line bg-accent/[0.06] px-4 py-3.5">
          <p className="text-[10px] font-medium tracking-[0.14em] text-accent uppercase">
            Datos extraídos
          </p>
          <h2 className="mt-1 text-base leading-6 font-semibold break-words text-foreground">
            {receipt.establecimiento}
          </h2>
          {receipt.fecha ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{formatDate(receipt.fecha)}</p>
          ) : null}
        </div>

        {products.length > 0 ? (
          <ul className="divide-y divide-line">
            {products.map((product, index) => (
              <ProductRow
                key={`${product.codigo_producto ?? "line"}-${index}`}
                product={product}
              />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-5 text-center text-xs leading-5 text-muted-foreground">
            No se detectaron líneas de producto en este tique.
          </p>
        )}

        <dl className="space-y-2 border-t border-line bg-surface-muted/60 px-4 py-3.5">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs text-muted-foreground">Impuestos totales</dt>
            <dd className="text-sm tabular-nums text-foreground">
              {formatMoney(receipt.impuestos_totales)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2.5">
            <dt className="text-sm font-semibold text-foreground">Gran total</dt>
            <dd className="text-base font-semibold tabular-nums text-accent">
              {formatMoney(receipt.gran_total)}
            </dd>
          </div>
        </dl>
      </div>

      <details className="group rounded-2xl border border-line bg-surface">
        <summary className="cursor-pointer list-none rounded-2xl px-4 py-3 text-xs font-medium text-muted-foreground transition hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
          Ver JSON crudo
        </summary>
        <pre className="max-h-64 overflow-auto border-t border-line px-4 py-3 font-mono text-[11px] leading-4 whitespace-pre-wrap break-all text-muted-foreground">
          {json}
        </pre>
      </details>

      <button type="button" onClick={onScanAnother} className={PRIMARY_BUTTON}>
        Escanear otro
      </button>
    </div>
  );
}
