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
