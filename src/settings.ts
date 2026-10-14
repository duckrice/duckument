import type { MarkKind } from "./model";

/** What the next added item looks like; remembered between sessions. */
export interface Settings {
  /** A font id from fonts.ts. */
  font: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  textColor: string;
  stroke: string;
  strokeWidth: number;
  fill: string | null;
  /** Whether the page sidebar is shown. */
  showPages: boolean;
  /** What the markup tool does, and its colour for each kind of mark. */
  markKind: MarkKind;
  markColors: Record<MarkKind, string>;
  noteColor: string;
}

const KEY = "freepdfeditor.settings";

const DEFAULTS: Settings = {
  font: "sans",
  fontSize: 12,
  bold: false,
  italic: false,
  textColor: "#000000",
  stroke: "#000000",
  strokeWidth: 1.5,
  fill: null,
  showPages: true,
  markKind: "highlight",
  markColors: { highlight: "#ffe14d", underline: "#d92626", strike: "#d92626" },
  noteColor: "#ffd43b",
};

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable or full; the defaults still work.
  }
}
