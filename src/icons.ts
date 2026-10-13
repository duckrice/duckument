// 24x24 outline icons, drawn with the current text colour.

const PATHS = {
  open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M8 3v5h7V3M7 21v-7h10v7"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  select: '<path d="m5 3 14 8-6.500 1.800L10 19z"/>',
  text: '<path d="M5 7V5h14v2M12 5v14M9 19h6"/>',
  sign: '<path d="M3 16c3-6 5.500-9 7-7.500 1.400 1.400-1.500 6 .5 6 2.500 0 3-5 5.500-5 2 0 1.500 4 3.500 4 1 0 1.500-.5 2.500-1"/><path d="M3 20h18"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  cross: '<path d="m6 6 12 12M18 6 6 18"/>',
  rect: '<rect x="4" y="5" width="16" height="14" rx="1"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  line: '<path d="M5 19 19 5"/>',
  arrow: '<path d="M5 19 19 5M10 5h9v9"/>',
  pen: '<path d="m4 20 1-4L16 5l3 3L8 19z"/><path d="m14 7 3 3"/>',
  whiteout: '<path d="m8 20-5-5L14 4l7 7-9 9z"/><path d="M8 20h12M8.500 9.500l6 6"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.500" cy="10" r="1.500"/><path d="m21 16-5-5-8 8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  caret: '<path d="m7 10 5 5 5-5"/>',
  document: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 18): string {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}
