// Text imports the viewer build resolves (scripts/build-viewer.mjs).
declare module "*.css" {
  const text: string;
  export default text;
}
declare module "pdfjs-dist/legacy/build/pdf.worker.min.mjs" {
  const source: string;
  export default source;
}
