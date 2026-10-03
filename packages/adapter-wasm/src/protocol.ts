/** Typed boundaries and copied shim data. Status consumers use decoded events,
 * never dereference the raw pointer numbers retained by the diagnostic probe. */
export interface RuntimePrompt {
  kind: "command" | "direction" | "key" | "text" | "yes_no_or_key" | "menu" | "more";
  label: string;
  choices?: string;
  allowMulti?: boolean;
  items?: { index: number; accelerator: string; label: string }[];
}

export interface GlyphInfo {
  symbolIndex: number;
  glyphFlags: number;
  ttychar: number;
}

export type RuntimeEvent =
  | { type: "started"; runtimeId: string }
  | { type: "input_required"; requestId: string; prompt: RuntimePrompt }
  | { type: "event"; sequence: number; name: string; data: Record<string, unknown> }
  | { type: "ended"; exitCode: number }
  | { type: "error"; message: string };

export interface RuntimeBoundary {
  requestId: string;
  prompt: RuntimePrompt;
}

/** Structural interface accepts a browser Worker and test transports alike. */
export interface RuntimeWorker {
  postMessage(message: unknown): void;
  addEventListener(type: "message" | "error", listener: (event: any) => void): void;
  removeEventListener(type: "message" | "error", listener: (event: any) => void): void;
  terminate(): void;
}
