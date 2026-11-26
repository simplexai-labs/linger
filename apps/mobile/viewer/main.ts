// The phone's offline file viewer: one HTML page, built by
// scripts/build-viewer.mjs, that a WebView opens beside a downloaded file.
// It renders with the libraries the desktop uses (pdf.js, open-file-viewer,
// papaparse, mermaid), so a file looks the same on both. The page reads the
// one file named in its URL fragment, sends no request off the phone (its
// Content-Security-Policy allows only file:, data: and blob:), and reports to
// the app only "loaded", "truncated" or "failed": the app owns every word
// the reader sees.
import { createViewer, officePlugin } from "@open-file-viewer/core";
import officeStyles from "@open-file-viewer/core/style.css";
import mermaid from "mermaid";
import Papa from "papaparse";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerSource from "pdfjs-dist/build/pdf.worker.min.mjs";

interface NativeBridge {
  postMessage(message: string): void;
}
declare global {
  interface Window {
    ReactNativeWebView?: NativeBridge;
  }
}

/** The renderers this page has; the app picks one per file. */
type Kind =
  | "pdf"
  | "office"
  | "csv"
  | "tsv"
  | "mermaid"
  | "html"
  | "image"
  | "text"
  | "video";

/** A table stops here: a phone draws a few thousand rows comfortably. */
const MAX_TABLE_ROWS = 5000;
/** The desktop's own cut: a table reads the first 5 MB of a file. */
const MAX_TABLE_BYTES = 5 * 1024 * 1024;

const params = new URLSearchParams(location.hash.slice(1));
const kind = params.get("kind") as Kind | null;
const source = params.get("src") ?? "";
const filename = params.get("name") ?? "";
const mediaType = params.get("type") ?? "";
const locale = params.get("lang") === "zh-CN" ? "zh-CN" : "en-US";
const root = document.getElementById("root") as HTMLElement;

function post(message: Record<string, unknown>) {
  window.ReactNativeWebView?.postMessage(JSON.stringify(message));
}

/** The file beside this page, as bytes; file: URLs answer XHR, not fetch. */
function readFile(): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    // Only a bare file name beside this page; never a path or another URL.
    if (!/^[A-Za-z0-9_.-]{1,160}$/.test(source)) {
      reject(new Error("Bad source"));
      return;
    }
    const request = new XMLHttpRequest();
    request.open("GET", source);
    request.responseType = "arraybuffer";
    request.onload = () =>
      request.response instanceof ArrayBuffer
        ? resolve(request.response)
        : reject(new Error("No content"));
    request.onerror = () => reject(new Error("Read failed"));
    request.send();
  });
}

function text(bytes: ArrayBuffer | Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

async function renderPdf(bytes: ArrayBuffer) {
  // pdf.js parses in a worker; the page has no worker file of its own, so
  // the worker source ships inside it and starts from a blob: URL.
  const workerUrl = URL.createObjectURL(
    new Blob([pdfWorkerSource], { type: "text/javascript" }),
  );
  pdfjs.GlobalWorkerOptions.workerPort = new Worker(workerUrl, {
    type: "module",
  });
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  root.className = "pages";
  const scale = Math.min(window.devicePixelRatio || 2, 3);
  const pages: HTMLCanvasElement[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = document.createElement("canvas");
    canvas.className = "page";
    canvas.dataset.page = String(number);
    // Holds the page's shape before it draws, so scrolling never jumps.
    canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    root.append(canvas);
    pages.push(canvas);
  }
  const drawn = new Set<number>();
  const draw = async (canvas: HTMLCanvasElement) => {
    const number = Number(canvas.dataset.page);
    if (drawn.has(number)) return;
    drawn.add(number);
    const page = await pdf.getPage(number);
    const width = canvas.clientWidth || root.clientWidth;
    const fit = width / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale: fit * scale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, viewport }).promise;
  };
  // Draws pages as they come near the screen, not all at once.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        if (entry.isIntersecting) void draw(entry.target as HTMLCanvasElement);
    },
    { rootMargin: "150% 0px" },
  );
  for (const canvas of pages) observer.observe(canvas);
  if (pages[0]) await draw(pages[0]);
}

function renderOffice(bytes: ArrayBuffer): Promise<void> {
  const style = document.createElement("style");
  style.textContent = officeStyles;
  document.head.append(style);
  root.className = "fill";
  return new Promise((resolve, reject) => {
    createViewer({
      container: root,
      fallback: "custom",
      file: bytes,
      fileName: filename,
      fit: "contain",
      height: "100%",
      locale,
      mimeType: mediaType || undefined,
      onError: (error) => reject(error),
      onLoad: () => resolve(),
      plugins: [officePlugin()],
      theme: "light",
      toolbar: false,
      width: "100%",
    });
  });
}

function renderTable(bytes: ArrayBuffer, delimiter: string) {
  const head = bytes.byteLength > MAX_TABLE_BYTES;
  const parsed = Papa.parse<string[]>(
    text(head ? bytes.slice(0, MAX_TABLE_BYTES) : bytes),
    { delimiter, skipEmptyLines: true },
  );
  const rows = parsed.data;
  // A cut file ends mid-row; that last row is dropped.
  if (head) rows.pop();
  const shown = rows.slice(0, MAX_TABLE_ROWS);
  const table = document.createElement("table");
  shown.forEach((row, index) => {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement(index === 0 ? "th" : "td");
      td.textContent = cell;
      tr.append(td);
    }
    table.append(tr);
  });
  root.className = "table";
  root.append(table);
  if (head || rows.length > shown.length)
    post({ kind: "truncated", rows: shown.length });
}

async function renderMermaid(bytes: ArrayBuffer) {
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  const { svg } = await mermaid.render("diagram", text(bytes));
  root.className = "diagram";
  root.innerHTML = svg;
}

function renderHtml(bytes: ArrayBuffer) {
  // No allow-scripts: the file's own scripts never run. The frame inherits
  // this page's policy, so it loads nothing from the network either.
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "");
  frame.srcdoc = text(bytes);
  root.className = "fill";
  root.append(frame);
}

function renderImage(bytes: ArrayBuffer) {
  const image = document.createElement("img");
  image.alt = "";
  image.src = URL.createObjectURL(
    new Blob([bytes], { type: mediaType || "application/octet-stream" }),
  );
  root.className = "image";
  root.append(image);
  return image.decode();
}

function renderText(bytes: ArrayBuffer) {
  const pre = document.createElement("pre");
  pre.textContent = text(bytes);
  root.className = "text";
  root.append(pre);
}

function renderVideo(bytes: ArrayBuffer) {
  const video = document.createElement("video");
  video.controls = true;
  video.playsInline = true;
  video.src = URL.createObjectURL(
    new Blob([bytes], { type: mediaType || "video/webm" }),
  );
  root.className = "image";
  root.append(video);
}

async function render() {
  const bytes = await readFile();
  switch (kind) {
    case "pdf":
      return renderPdf(bytes);
    case "office":
      return renderOffice(bytes);
    case "csv":
      return renderTable(bytes, ",");
    case "tsv":
      return renderTable(bytes, "\t");
    case "mermaid":
      return renderMermaid(bytes);
    case "html":
      return renderHtml(bytes);
    case "image":
      return renderImage(bytes);
    case "text":
      return renderText(bytes);
    case "video":
      return renderVideo(bytes);
    default:
      throw new Error("Unknown kind");
  }
}

render().then(
  () => post({ kind: "loaded" }),
  (error: unknown) =>
    post({
      kind: "failed",
      detail: error instanceof Error ? error.message : String(error),
    }),
);
