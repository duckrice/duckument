// Creating signatures (drawn, typed or from a picture) and remembering them.
// A signature is a transparent PNG; this is a visual signature, not a
// certificate-based digital one.

import { h } from "./dom";
import { pickImage } from "./platform";

export interface Signature {
  id: string;
  src: string;
  /** Pixel size of the PNG, used for its aspect ratio. */
  w: number;
  h: number;
}

const KEY = "freepdfeditor.signatures";
const MAX_SAVED = 8;
const INKS = ["#111111", "#1a3fb0"];
const SCRIPT_FONTS = ["Segoe Script", "Ink Free", "Lucida Handwriting", "Gabriola"];
/** Drawn signatures are stored at this multiple of their on-screen size so they stay sharp in print. */
const EXPORT_SCALE = 3;
const PEN_WIDTH = 2.6;

export function loadSignatures(): Signature[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function storeSignatures(list: Signature[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_SAVED)));
    return true;
  } catch {
    return false;
  }
}

/** The size, in points, a signature gets when first placed on a page. */
export function placedSize(signature: Signature): { w: number; h: number } {
  const aspect = signature.w / signature.h;
  const w = Math.min(160, 56 * aspect);
  return { w, h: w / aspect };
}

/** Crops a canvas to its non-transparent pixels. Returns null when it is blank. */
function trimmed(canvas: HTMLCanvasElement): Omit<Signature, "id"> | null {
  const ctx = canvas.getContext("2d")!;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < left || bottom < top) return null;
  const out = document.createElement("canvas");
  out.width = right - left + 1;
  out.height = bottom - top + 1;
  out.getContext("2d")!.drawImage(canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return { src: out.toDataURL("image/png"), w: out.width, h: out.height };
}

type Stroke = number[];

function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], ink: string, scale: number) {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.strokeStyle = ctx.fillStyle = ink;
  ctx.lineWidth = PEN_WIDTH;
  ctx.lineCap = ctx.lineJoin = "round";
  for (const s of strokes) {
    if (s.length === 2) {
      ctx.beginPath();
      ctx.arc(s[0], s[1], PEN_WIDTH / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(s[0], s[1]);
    // Curve through the midpoints so the line doesn't show its sample points.
    for (let i = 2; i < s.length - 2; i += 2) {
      ctx.quadraticCurveTo(s[i], s[i + 1], (s[i] + s[i + 2]) / 2, (s[i + 1] + s[i + 3]) / 2);
    }
    ctx.lineTo(s[s.length - 2], s[s.length - 1]);
    ctx.stroke();
  }
  ctx.restore();
}

interface Pane {
  el: HTMLElement;
  result(): Promise<Omit<Signature, "id"> | null> | Omit<Signature, "id"> | null;
  shown?(): void;
}

function inkPicker(onChange: (ink: string) => void): HTMLElement {
  const buttons = INKS.map((ink, i) =>
    h("button", {
      type: "button",
      class: `swatch${i === 0 ? " active" : ""}`,
      style: `--c:${ink}`,
      title: i === 0 ? "Black ink" : "Blue ink",
      onclick: () => {
        buttons.forEach((b, j) => b.classList.toggle("active", j === i));
        onChange(ink);
      },
    }),
  );
  return h("div", { class: "swatches" }, ...buttons);
}

function drawPane(): Pane {
  const canvas = h("canvas", { class: "sig-pad" });
  const strokes: Stroke[] = [];
  let ink = INKS[0];
  let current: Stroke | null = null;

  const redraw = () => {
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawStrokes(ctx, strokes, ink, canvas.width / canvas.clientWidth);
  };
  const fit = () => {
    const density = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * density);
    canvas.height = Math.round(canvas.clientHeight * density);
    redraw();
  };
  const point = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    current = point(event);
    strokes.push(current);
    redraw();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!current) return;
    const samples = event.getCoalescedEvents?.() ?? [];
    for (const sample of samples.length ? samples : [event]) current.push(...point(sample));
    redraw();
  });
  const end = () => (current = null);
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  const controls = h(
    "div",
    { class: "sig-controls" },
    inkPicker((value) => {
      ink = value;
      redraw();
    }),
    h("span", { class: "sig-hint" }, "Sign with your mouse, pen or finger"),
    h(
      "button",
      {
        type: "button",
        class: "btn subtle",
        onclick: () => {
          strokes.pop();
          redraw();
        },
      },
      "Undo",
    ),
    h(
      "button",
      {
        type: "button",
        class: "btn subtle",
        onclick: () => {
          strokes.length = 0;
          redraw();
        },
      },
      "Clear",
    ),
  );

  return {
    el: h("div", { class: "sig-pane" }, canvas, controls),
    shown: fit,
    result() {
      if (!strokes.length) return null;
      const out = document.createElement("canvas");
      out.width = canvas.clientWidth * EXPORT_SCALE;
      out.height = canvas.clientHeight * EXPORT_SCALE;
      drawStrokes(out.getContext("2d")!, strokes, ink, EXPORT_SCALE);
      return trimmed(out);
    },
  };
}

function typePane(): Pane {
  let ink = INKS[0];
  let font = SCRIPT_FONTS[0];
  const input = h("input", { class: "sig-name", type: "text", placeholder: "Type your name", maxlength: 60 });
  const options = SCRIPT_FONTS.map((name, i) =>
    h("button", {
      type: "button",
      class: `sig-font${i === 0 ? " active" : ""}`,
      style: `font-family:"${name}",cursive`,
      onclick: () => {
        font = name;
        options.forEach((b, j) => b.classList.toggle("active", j === i));
      },
    }),
  );
  const refresh = () => {
    for (const option of options) {
      option.textContent = input.value || "Your name";
      option.style.color = ink;
    }
  };
  input.addEventListener("input", refresh);
  refresh();

  return {
    el: h(
      "div",
      { class: "sig-pane" },
      input,
      h("div", { class: "sig-fonts" }, ...options),
      h(
        "div",
        { class: "sig-controls" },
        inkPicker((value) => {
          ink = value;
          refresh();
        }),
      ),
    ),
    shown: () => input.focus(),
    result() {
      const text = input.value.trim();
      if (!text) return null;
      const size = 120;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      const css = `${size}px "${font}", cursive`;
      ctx.font = css;
      canvas.width = Math.ceil(ctx.measureText(text).width + size * 2);
      canvas.height = size * 3;
      ctx.font = css;
      ctx.fillStyle = ink;
      ctx.fillText(text, size, size * 1.8);
      return trimmed(canvas);
    },
  };
}

/** Makes the paper of a photographed or scanned signature transparent, keeping the ink. */
function removePaper(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = image;
  const luma = (i: number) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

  // The paper is whatever brightness most of the picture has.
  const histogram = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) histogram[Math.round(luma(i))]++;
  let seen = 0;
  let paper = 255;
  const target = (data.length / 4) * 0.6;
  for (let level = 255; level >= 0; level--) {
    seen += histogram[level];
    if (seen >= target) {
      paper = level;
      break;
    }
  }
  const clear = paper - 22;
  const solid = Math.max(0, paper - 110);

  for (let i = 0; i < data.length; i += 4) {
    const alpha = Math.min(1, Math.max(0, (clear - luma(i)) / (clear - solid || 1))) * (data[i + 3] / 255);
    if (alpha > 0) {
      // Undo the blend with the paper so edges don't keep a pale halo.
      for (let c = 0; c < 3; c++) {
        data[i + c] = Math.min(255, Math.max(0, (data[i + c] - paper * (1 - alpha)) / alpha));
      }
    }
    data[i + 3] = Math.round(alpha * 255);
  }
  ctx.putImageData(image, 0, 0);
}

function imagePane(): Pane {
  let source: ImageBitmap | null = null;
  const preview = h("canvas", { class: "sig-preview" });
  const remove = h("input", { type: "checkbox", checked: true });
  const empty = h("div", { class: "sig-empty" }, "Choose a photo or scan of your signature on white paper.");

  const render = () => {
    if (!source) return;
    const shrink = Math.min(1, 1600 / Math.max(source.width, source.height));
    preview.width = Math.round(source.width * shrink);
    preview.height = Math.round(source.height * shrink);
    const ctx = preview.getContext("2d")!;
    ctx.drawImage(source, 0, 0, preview.width, preview.height);
    if (remove.checked) removePaper(preview);
    empty.hidden = true;
    preview.hidden = false;
  };
  remove.addEventListener("change", render);
  preview.hidden = true;

  const choose = async () => {
    const blob = await pickImage();
    if (!blob) return;
    try {
      source = await createImageBitmap(blob);
      render();
    } catch {
      empty.textContent = "That file could not be read as a picture.";
    }
  };

  return {
    el: h(
      "div",
      { class: "sig-pane" },
      h("div", { class: "sig-image-box" }, empty, preview),
      h(
        "div",
        { class: "sig-controls" },
        h("button", { type: "button", class: "btn", onclick: () => void choose() }, "Choose picture…"),
        h("label", { class: "check" }, remove, "Remove paper background"),
      ),
    ),
    result: () => (source ? trimmed(preview) : null),
  };
}

/** Shows the "create signature" dialog. Resolves to the new signature, or null if cancelled. */
export function createSignature(): Promise<{ signature: Signature; remember: boolean } | null> {
  return new Promise((resolve) => {
    const panes: [string, Pane][] = [
      ["Draw", drawPane()],
      ["Type", typePane()],
      ["Picture", imagePane()],
    ];
    let active = 0;
    const tabs = panes.map(([label], i) =>
      h("button", { type: "button", class: "tab", role: "tab", onclick: () => show(i) }, label),
    );
    const body = h("div", { class: "sig-body" });
    const remember = h("input", { type: "checkbox", checked: true });
    const error = h("span", { class: "dialog-error" });

    const show = (index: number) => {
      active = index;
      tabs.forEach((tab, i) => tab.classList.toggle("active", i === index));
      body.replaceChildren(panes[index][1].el);
      panes[index][1].shown?.();
      error.textContent = "";
    };

    const dialog = h(
      "dialog",
      { class: "dialog sig-dialog" },
      h("h2", {}, "Create signature"),
      h("div", { class: "tabs", role: "tablist" }, ...tabs),
      body,
      h(
        "div",
        { class: "dialog-footer" },
        h("label", { class: "check" }, remember, "Remember this signature on this computer"),
        error,
        h("button", { type: "button", class: "btn", onclick: () => dialog.close() }, "Cancel"),
        h(
          "button",
          {
            type: "button",
            class: "btn primary",
            onclick: async () => {
              const result = await panes[active][1].result();
              if (!result) {
                error.textContent = "There is no signature yet.";
                return;
              }
              done = { signature: { id: `${Date.now()}`, ...result }, remember: remember.checked };
              dialog.close();
            },
          },
          "Use signature",
        ),
      ),
    );

    let done: { signature: Signature; remember: boolean } | null = null;
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(done);
    });
    document.body.append(dialog);
    dialog.showModal();
    show(0);
  });
}
