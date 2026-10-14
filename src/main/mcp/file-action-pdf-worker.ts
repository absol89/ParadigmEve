/**
 * Trusted worker bootstrap for the built-in PDF reader.
 *
 * PDF.js parsing is synchronous for long stretches, so a timer in the main process cannot stop a
 * hostile document. This runs in its own worker with V8 heap limits; the owner terminates it on
 * the wall-clock deadline. Text is bounded here, page by page, so an oversized slice never crosses
 * back into the app, let alone reaches a model. Errors carry no document text.
 */
export const PDF_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const send = message => parentPort.postMessage(message);
(async () => {
  let task = null;
  try {
    const pdfjs = await import(pathToFileURL(workerData.pdfjsModule).href);
    task = pdfjs.getDocument({
      data: workerData.bytes,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      stopAtErrors: false,
      verbosity: 0
    });
    const pdf = await task.promise;
    const total = pdf.numPages;
    if (workerData.start > total) { send({ ok: false, error: 'PAGE_OUT_OF_RANGE: PDF has ' + total + ' pages.' }); return; }
    const end = Math.min(workerData.end, total);
    const pages = [];
    let chars = 0;
    let stopped = false;
    for (let number = workerData.start; number <= end; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      let text = content.items.map(item => typeof item.str === 'string' ? item.str : '').join(' ').replace(/\s+/g, ' ').trim();
      const room = workerData.maxChars - chars;
      if (text.length > room) { text = text.slice(0, Math.max(0, room)); stopped = true; }
      pages.push({ number, text });
      chars += text.length;
      page.cleanup();
      if (stopped) break;
    }
    send({ ok: true, total, pages, stopped });
  } catch (err) {
    const name = err && typeof err.name === 'string' ? err.name : 'Error';
    send({ ok: false, error: 'MALFORMED_PDF: PDF.js could not read this file (' + name.slice(0, 60) + ').' });
  } finally {
    if (task) { try { await task.destroy(); } catch {} }
  }
})();
`;
