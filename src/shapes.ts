// One geometry description per item, used for both the on-screen SVG and the
// saved PDF so the two can't drift apart.

import type { Item } from "./model";

export type PathCmd =
  | ["M", number, number]
  | ["L", number, number]
  | ["C", number, number, number, number, number, number]
  | ["Z"];

export interface Paint {
  cmds: PathCmd[];
  stroke: string | null;
  fill: string | null;
  width: number;
  /** Round caps and joins (freehand, marks, lines) or sharp ones (rectangles). */
  round: boolean;
}

// Control point offset that makes a cubic Bézier approximate a quarter circle.
const KAPPA = 0.5522847498;

function ellipse(x: number, y: number, w: number, h: number): PathCmd[] {
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  return [
    ["M", cx + rx, cy],
    ["C", cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry],
    ["C", cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy],
    ["C", cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry],
    ["C", cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy],
    ["Z"],
  ];
}

/** Smooths a polyline by curving through the midpoints of its segments. */
function smooth(pts: number[]): PathCmd[] {
  const n = pts.length / 2;
  if (n === 0) return [];
  const cmds: PathCmd[] = [["M", pts[0], pts[1]]];
  if (n === 1) {
    cmds.push(["L", pts[0], pts[1]]);
    return cmds;
  }
  if (n === 2) {
    cmds.push(["L", pts[2], pts[3]]);
    return cmds;
  }
  let px = pts[0];
  let py = pts[1];
  for (let i = 1; i < n - 1; i++) {
    const cx = pts[i * 2];
    const cy = pts[i * 2 + 1];
    const mx = (cx + pts[i * 2 + 2]) / 2;
    const my = (cy + pts[i * 2 + 3]) / 2;
    // Quadratic (px,py) -> (mx,my) with control (cx,cy), written as a cubic.
    cmds.push([
      "C",
      px + (2 / 3) * (cx - px),
      py + (2 / 3) * (cy - py),
      mx + (2 / 3) * (cx - mx),
      my + (2 / 3) * (cy - my),
      mx,
      my,
    ]);
    px = mx;
    py = my;
  }
  cmds.push(["L", pts[n * 2 - 2], pts[n * 2 - 1]]);
  return cmds;
}

export function paints(item: Item): Paint[] {
  switch (item.type) {
    case "rect":
      return [
        {
          cmds: [
            ["M", item.x, item.y],
            ["L", item.x + item.w, item.y],
            ["L", item.x + item.w, item.y + item.h],
            ["L", item.x, item.y + item.h],
            ["Z"],
          ],
          stroke: item.stroke,
          fill: item.fill,
          width: item.strokeWidth,
          round: false,
        },
      ];
    case "ellipse":
      return [
        {
          cmds: ellipse(item.x, item.y, item.w, item.h),
          stroke: item.stroke,
          fill: item.fill,
          width: item.strokeWidth,
          round: false,
        },
      ];
    case "line":
      return [
        {
          cmds: [
            ["M", item.x1, item.y1],
            ["L", item.x2, item.y2],
          ],
          stroke: item.stroke,
          fill: null,
          width: item.strokeWidth,
          round: true,
        },
      ];
    case "arrow": {
      const dx = item.x2 - item.x1;
      const dy = item.y2 - item.y1;
      const len = Math.hypot(dx, dy);
      if (len < 0.01) return [];
      const ux = dx / len;
      const uy = dy / len;
      const head = Math.min(len, Math.max(8, item.strokeWidth * 4.5));
      const half = head * 0.38;
      // The shaft stops inside the head so the tip stays sharp.
      const bx = item.x2 - ux * head;
      const by = item.y2 - uy * head;
      return [
        {
          cmds: [
            ["M", item.x1, item.y1],
            ["L", item.x2 - ux * head * 0.8, item.y2 - uy * head * 0.8],
          ],
          stroke: item.stroke,
          fill: null,
          width: item.strokeWidth,
          round: true,
        },
        {
          cmds: [
            ["M", item.x2, item.y2],
            ["L", bx - uy * half, by + ux * half],
            ["L", bx + uy * half, by - ux * half],
            ["Z"],
          ],
          stroke: null,
          fill: item.stroke,
          width: 0,
          round: false,
        },
      ];
    }
    case "check": {
      const { x, y, w, h } = item;
      return [
        {
          cmds: [
            ["M", x + w * 0.1, y + h * 0.55],
            ["L", x + w * 0.38, y + h * 0.84],
            ["L", x + w * 0.9, y + h * 0.16],
          ],
          stroke: item.stroke,
          fill: null,
          width: item.strokeWidth,
          round: true,
        },
      ];
    }
    case "cross": {
      const { x, y, w, h } = item;
      return [
        {
          cmds: [
            ["M", x + w * 0.14, y + h * 0.14],
            ["L", x + w * 0.86, y + h * 0.86],
            ["M", x + w * 0.86, y + h * 0.14],
            ["L", x + w * 0.14, y + h * 0.86],
          ],
          stroke: item.stroke,
          fill: null,
          width: item.strokeWidth,
          round: true,
        },
      ];
    }
    case "pen": {
      const pts = item.points.map((v, i) => (i % 2 === 0 ? item.x + v * item.w : item.y + v * item.h));
      return [{ cmds: smooth(pts), stroke: item.stroke, fill: null, width: item.strokeWidth, round: true }];
    }
    default:
      return [];
  }
}

export function svgPath(cmds: PathCmd[]): string {
  return cmds.map((c) => (c.length === 1 ? c[0] : `${c[0]}${c.slice(1).join(" ")}`)).join("");
}
