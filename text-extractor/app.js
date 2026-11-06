/**
 * Text Extractor — client-side screenshot OCR.
 *
 * High-level flow:
 *   1. The user provides an image one of three ways — file picker, drag & drop,
 *      or pasting a screenshot from the clipboard.
 *   2. `handleImage()` previews the image and hands it to Tesseract.js.
 *   3. Tesseract.js runs OCR (Optical Character Recognition) entirely in the
 *      browser via WebAssembly — the image is never uploaded anywhere.
 *   4. The recognized text is shown in an editable box that the user can
 *      copy to the clipboard or download as a .txt file.
 *
 * There is no build step and no backend; this single HTML file is the whole app.
 */

// ---- Cached DOM references ------------------------------------------
// Look these elements up once at startup so the rest of the code can reuse
// them without repeated getElementById() calls.
const dropzone   = document.getElementById('dropzone');   // the click/drop target
const fileInput  = document.getElementById('fileInput');  // hidden <input type="file">
const preview    = document.getElementById('preview');    // <img> thumbnail of the chosen image
const previewWrap= document.getElementById('previewWrap');// wrapper toggled to show/hide the preview
const progress   = document.getElementById('progress');   // wrapper for the progress bar + status line
const barFill    = document.getElementById('barFill');    // the coloured fill inside the progress bar
const statusEl   = document.getElementById('status');     // human-readable status text
const resultWrap = document.getElementById('resultWrap'); // wrapper for the result textarea + buttons
const output     = document.getElementById('output');     // <textarea> holding the recognized text
const copyBtn    = document.getElementById('copyBtn');    // "Copy" button
const downloadBtn= document.getElementById('downloadBtn');// "Download .txt" button
const clearBtn   = document.getElementById('clearBtn');   // "Clear" button
const langSelect = document.getElementById('lang');       // language <select>
const layoutEl   = document.getElementById('layout');     // page segmentation mode <select>
const enhanceEl  = document.getElementById('enhance');    // "Enhance image" checkbox

// Guard flag: true while an OCR job is in flight. Prevents a second image
// from being processed (and corrupting the UI) before the first finishes.
let isRunning = false;

// ---- Input handlers -------------------------------------------------
// There are three ways to supply an image; each ends up calling handleImage().

// (a) Click the dropzone -> open the native file picker.
dropzone.addEventListener('click', () => fileInput.click());

// (a') Keyboard accessibility: Enter or Space on the focused dropzone also
//      opens the file picker, so the app is usable without a mouse.
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});

// (a'') When the user picks a file in that dialog, process the first one.
fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) handleImage(e.target.files[0]);
  // Reset so picking the same file again still fires 'change'.
  e.target.value = '';
});

// (b) Drag & drop. We must preventDefault() on dragenter/dragover, otherwise
//     the browser navigates away to open the dropped file. We also toggle a
//     CSS class to give visual feedback while a file hovers over the zone.
['dragenter', 'dragover'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); })
);
['dragleave', 'drop'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); })
);
// The actual drop: pull the first dropped file out of the DataTransfer object.
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleImage(file);
});

// (c) Paste from clipboard. Listening on `window` means the user can press
//     Ctrl/Cmd+V anywhere on the page after taking a screenshot. We scan the
//     clipboard items for the first one whose MIME type starts with "image".
window.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.indexOf('image') === 0) {
      handleImage(item.getAsFile()); // convert the clipboard item into a File
      break;                          // only handle the first image
    }
  }
});

// ---- OCR core --------------------------------------------------------

// One Tesseract worker is created lazily and reused for every run, so the
// engine and language data are only loaded once (and again only if the
// language changes).
let worker = null;
let workerLang = null;
let pendingFile = null;   // latest image supplied while a job was running
let previewUrl = null;    // current preview object URL (revoked when replaced)

// The worker's logger is fixed at creation, so it delegates to this
// function, which always writes to the current UI.
function onProgress(m) {
  if (m.status === 'recognizing text') {
    const pct = Math.round(m.progress * 100); // m.progress is 0..1
    barFill.style.width = pct + '%';
    statusEl.textContent = `Recognizing text… ${pct}%`;
  } else {
    // Capitalize the phase name for a tidier status, e.g. "Loading language…".
    statusEl.textContent = m.status.charAt(0).toUpperCase() + m.status.slice(1) + '…';
  }
}

async function getWorker(lang) {
  if (!worker) {
    // Use the higher-accuracy "best" LSTM models (larger download, noticeably
    // better on punctuation and symbols such as ** # > than the default "fast" ones).
    worker = await Tesseract.createWorker(lang, 1, {
      logger: onProgress,
      langPath: 'https://tessdata.projectnaptha.com/4.0.0_best',
    });
    workerLang = lang;
  } else if (workerLang !== lang) {
    await worker.reinitialize(lang);
    workerLang = lang;
  }
  return worker;
}

// Show a message in the status line (red when it's an error).
function setStatus(text, isError = false) {
  progress.classList.add('show');
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function setPreview(file) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  preview.src = previewUrl;
  previewWrap.classList.add('show');
}

/**
 * Prepare a screenshot for OCR. Tesseract works best on large, dark-on-light,
 * high-contrast text, but screenshots are usually small and often dark-themed.
 *   1. Upscale small images (text ~30px tall is ideal for Tesseract).
 *   2. Convert to grayscale (luminance).
 *   3. If the image is mostly dark, invert it to dark-on-light.
 *   4. Stretch contrast between the 2nd and 98th brightness percentiles.
 *   5. Add a white margin, which helps Tesseract detect edge text.
 * @returns {Promise<Blob>} a PNG blob to hand to Tesseract
 */
async function preprocess(file) {
  const bmp = await createImageBitmap(file);
  let scale = bmp.width < 1000 ? 3 : bmp.width < 2000 ? 2 : 1;
  while (scale > 1 && bmp.width * bmp.height * scale * scale > 24e6) scale--;
  const pad = 24;
  const w = bmp.width * scale, h = bmp.height * scale;

  const canvas = document.createElement('canvas');
  canvas.width = w + pad * 2;
  canvas.height = h + pad * 2;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, pad, pad, w, h);
  bmp.close();

  const img = ctx.getImageData(pad, pad, w, h);
  const px = img.data;
  const n = w * h;
  const gray = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    // Composite transparency onto white, then take luminance.
    const a = px[j + 3] / 255;
    const r = px[j] * a + 255 * (1 - a);
    const g = px[j + 1] * a + 255 * (1 - a);
    const b = px[j + 2] * a + 255 * (1 - a);
    const v = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    gray[i] = v; hist[v]++; sum += v;
  }
  const invert = sum / n < 128;           // dark background -> flip
  if (invert) { hist.reverse(); }          // keep the histogram in sync with the flip

  const pct = (frac) => {
    let acc = 0; const target = n * frac;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
    return 255;
  };
  const lo = pct(0.02), hi = Math.max(pct(0.98), lo + 1);
  const range = hi - lo;

  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let v = invert ? 255 - gray[i] : gray[i];
    v = Math.max(0, Math.min(255, ((v - lo) * 255) / range));
    px[j] = px[j + 1] = px[j + 2] = v;
    px[j + 3] = 255;
  }
  ctx.putImageData(img, pad, pad);
  return new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('Could not prepare image')), 'image/png'));
}

/**
 * Run OCR on a single image and render the result.
 *
 * If a job is already running, the newest image is queued and processed
 * as soon as the current one finishes (newer images replace older queued ones).
 *
 * @param {File|Blob} file - The image to recognize (from picker, drop, or paste).
 * @returns {Promise<void>}
 */
async function handleImage(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('That is not an image file — please provide a PNG, JPG, WebP or GIF.', true);
    return;
  }
  if (isRunning) {
    pendingFile = file;
    statusEl.classList.remove('error');
    statusEl.textContent += ' (next image queued)';
    return;
  }

  setPreview(file);

  // Move the UI into its "working" state.
  isRunning = true;
  output.value = '';
  resultWrap.classList.remove('show');
  barFill.style.width = '0%';
  setStatus('Loading OCR engine…');

  try {
    const w = await getWorker(langSelect.value); // e.g. "eng", "deu", "eng+deu"
    let input = file;
    if (enhanceEl.checked) {
      setStatus('Enhancing image…');
      try { input = await preprocess(file); }
      catch (e) { console.warn('Preprocessing failed, using original image', e); }
    }
    // PSM 6 = "single uniform block of text": fits code/markdown/terminal
    // screenshots far better than full page analysis, which tends to drop or
    // merge symbol-only fragments. Keep spacing so indentation survives.
    await w.setParameters({
      tessedit_pageseg_mode: layoutEl.value,
      preserve_interword_spaces: '1',
    });
    const { data } = await w.recognize(input);
    const text = data.text.trim();
    output.value = text;
    resultWrap.classList.add('show');
    setStatus(`Done — extracted ${text.length} characters.`);
    barFill.style.width = '100%';
  } catch (err) {
    setStatus('Error: ' + (err && err.message ? err.message : err), true);
    console.error(err);
    // The worker may be in a bad state; discard it so the next run starts fresh.
    if (worker) { worker.terminate().catch(() => {}); worker = null; workerLang = null; }
  } finally {
    isRunning = false;
    if (pendingFile) {
      const next = pendingFile;
      pendingFile = null;
      handleImage(next);
    }
  }
}

// ---- Result actions --------------------------------------------------

/**
 * Copy the recognized text to the system clipboard.
 * Prefers the modern async Clipboard API and falls back to the legacy
 * execCommand('copy') for older browsers or insecure (non-HTTPS) contexts.
 */
copyBtn.addEventListener('click', async () => {
  if (!output.value) return; // nothing to copy
  let ok = false;
  try {
    await navigator.clipboard.writeText(output.value);
    ok = true;
  } catch {
    // Fallback: select the textarea contents and use the old copy command.
    output.select();
    ok = document.execCommand('copy');
  }
  // Briefly flip the label to confirm the outcome.
  const orig = 'Copy';
  copyBtn.textContent = ok ? 'Copied!' : 'Copy failed';
  setTimeout(() => (copyBtn.textContent = orig), 1500);
});

/**
 * Download the recognized text as "extracted-text.txt".
 * Builds an in-memory text Blob, points a temporary <a download> at it, and
 * programmatically clicks it to trigger the browser's save dialog. No server
 * round-trip is involved.
 */
downloadBtn.addEventListener('click', () => {
  if (!output.value) return; // nothing to download
  const blob = new Blob([output.value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);     // temporary URL for the blob
  const a = document.createElement('a');
  a.href = url;
  a.download = 'extracted-text.txt';         // suggested filename
  document.body.appendChild(a);
  a.click();                                  // trigger the download
  a.remove();
  URL.revokeObjectURL(url);                   // free the blob URL
});

/**
 * Reset the app to its initial empty state: clear the text, drop the preview,
 * and hide the preview / progress / result panels so a fresh image can start clean.
 */
clearBtn.addEventListener('click', () => {
  output.value = '';
  pendingFile = null;
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  preview.src = '';
  previewWrap.classList.remove('show');
  resultWrap.classList.remove('show');
  progress.classList.remove('show');
  fileInput.value = ''; // allow re-selecting the same file again
});
