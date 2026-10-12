import CameraScanner from "@/components/CameraScanner";
import { ScanIcon } from "@/components/icons";

export default function Home() {
  return (
    <div className="app-background relative flex min-h-dvh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-line bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex w-full max-w-lg items-center gap-3 px-4 py-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent ring-1 ring-accent/25">
            <ScanIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight text-foreground">
              TicketScan
            </p>
            <p className="truncate text-[11px] text-muted-foreground">Tiques y facturas</p>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col px-4 py-4">
        <CameraScanner />
      </main>

      <footer className="border-t border-line bg-background/70 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur">
        <p className="mx-auto max-w-lg text-center text-[11px] leading-4 text-muted-foreground">
          Captura la foto y la IA extrae los datos del tique en un momento.
        </p>
      </footer>
    </div>
  );
}
