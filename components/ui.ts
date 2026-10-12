/**
 * Shared action styles for the camera viewfinder and the receipt result,
 * so both use exactly the same visual language.
 *
 * There is an "on dark" variant for controls overlaid on the
 * camera viewfinder (live video / photo), which keeps the dark area.
 */

export const PRIMARY_BUTTON =
  "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-white transition hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:scale-[0.98]";

export const PRIMARY_BUTTON_ON_DARK =
  "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-bright active:scale-[0.98]";

export const SECONDARY_BUTTON =
  "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-medium text-foreground transition hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:scale-[0.98]";

export const SECONDARY_BUTTON_ON_DARK =
  "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 text-sm font-medium text-zinc-100 transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-bright active:scale-[0.98]";

/** Circular button only inside the dark viewfinder (controls over the video). */
export const ICON_BUTTON =
  "grid h-11 w-11 place-items-center rounded-full border border-white/25 bg-black/45 text-zinc-100 backdrop-blur transition hover:bg-black/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-bright disabled:opacity-40";
