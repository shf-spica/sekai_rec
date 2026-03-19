/**
 * PARSeq 文字認識 Web Worker
 * crop 済み画像を直接 PARSeq-NDL-30 で認識する（レイアウト検出不要）
 * 参考: yuta1984/ndlocrlite-web
 */

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.wasm.min.mjs';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'warning';
ort.env.wasm.proxy = false;

const MODEL_BASE_URL = '/models';
const DB_NAME = 'NDLOCRLiteDB_prsk';
const DB_VERSION = 1;
const STORE_NAME = 'models';
const MODEL_VERSION = '1.0.0';

let recSession = null;
let charList = [];
const REC_INPUT_SHAPE = [1, 3, 16, 256];

function post(msg) { self.postMessage(msg); }

// ─── IndexedDB cache ───

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME))
        db.createObjectStore(STORE_NAME, { keyPath: 'name' });
    };
  });
}

async function getCached(name) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(name);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const entry = req.result;
      resolve(entry?.version === MODEL_VERSION ? entry.data : undefined);
    };
  });
}

async function saveCache(name, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put({ name, data, version: MODEL_VERSION, cachedAt: Date.now() });
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
}

async function downloadModel(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) throw new Error(`Model not found (HTML returned): ${url}`);
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress && total > 0) onProgress(received / total);
  }
  const buf = new Uint8Array(received);
  let pos = 0;
  for (const c of chunks) { buf.set(c, pos); pos += c.length; }
  return buf.buffer;
}

async function loadModel(name, url, onProgress) {
  const cached = await getCached(name);
  if (cached) { if (onProgress) onProgress(1); return cached; }
  const data = await downloadModel(url, onProgress);
  await saveCache(name, data);
  return data;
}

// ─── Charset config ───

async function loadCharset() {
  try {
    const res = await fetch('/config/NDLmoji.yaml');
    const text = await res.text();
    const m = text.match(/charset_train:\s*"([^"]*)"/);
    if (m) charList = m[1].split('');
  } catch (e) {
    console.warn('Failed to load charset:', e);
  }
}

// ─── Text Recognition (PARSeq) ───

function preprocessRec(croppedImageData) {
  const [, ch, h, w] = REC_INPUT_SHAPE;
  const iw = croppedImageData.width, ih = croppedImageData.height;
  const tmpCanvas = new OffscreenCanvas(iw, ih);
  tmpCanvas.getContext('2d').putImageData(croppedImageData, 0, 0);

  let srcCanvas;
  if (ih > iw) {
    srcCanvas = new OffscreenCanvas(ih, iw);
    const ctx = srcCanvas.getContext('2d');
    ctx.translate(ih / 2, iw / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.translate(-iw / 2, -ih / 2);
    ctx.drawImage(tmpCanvas, 0, 0);
  } else {
    srcCanvas = tmpCanvas;
  }

  const resizeCanvas = new OffscreenCanvas(w, h);
  resizeCanvas.getContext('2d').drawImage(srcCanvas, 0, 0, w, h);
  const { data } = resizeCanvas.getContext('2d').getImageData(0, 0, w, h);
  const tensorData = new Float32Array(ch * h * w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = (y * w + x) * 4;
      for (let c = 0; c < ch; c++)
        tensorData[c * h * w + y * w + x] = 2.0 * (data[px + c] / 255.0 - 0.5);
    }
  }
  return new ort.Tensor('float32', tensorData, REC_INPUT_SHAPE);
}

async function recognizeText(croppedImageData) {
  const tensor = preprocessRec(croppedImageData);
  const output = await recSession.run({ [recSession.inputNames[0]]: tensor });
  const logits = Array.from(output[recSession.outputNames[0]].data).map(v => typeof v === 'bigint' ? Number(v) : v);
  const dims = output[recSession.outputNames[0]].dims;
  const [, seqLen, vocabSize] = dims;
  const ids = [];
  for (let i = 0; i < seqLen; i++) {
    const slice = logits.slice(i * vocabSize, (i + 1) * vocabSize);
    const maxIdx = slice.indexOf(Math.max(...slice));
    if (maxIdx === 0) break;
    if (maxIdx < 4) continue;
    ids.push(maxIdx - 1);
  }
  const chars = [];
  let prev = -1;
  for (const id of ids) {
    if (id !== prev && id < charList.length) { chars.push(charList[id]); prev = id; }
  }
  return chars.join('').trim();
}

// ─── Worker message handling ───

let initialized = false;

async function initialize() {
  if (initialized) return;
  post({ type: 'PROGRESS', stage: 'loading', progress: 0.05, message: 'Loading charset...' });
  await loadCharset();

  post({ type: 'PROGRESS', stage: 'loading', progress: 0.10, message: 'Loading recognition model...' });
  const recData = await loadModel('rec30', `${MODEL_BASE_URL}/parseq-ndl-30.onnx`, p => {
    post({ type: 'PROGRESS', stage: 'loading', progress: 0.10 + p * 0.60, message: `Loading model... ${Math.round(p * 100)}%` });
  });

  post({ type: 'PROGRESS', stage: 'init_session', progress: 0.75, message: 'Preparing model...' });
  const sessionOpts = { executionProviders: ['wasm'], logSeverityLevel: 4, graphOptimizationLevel: 'basic', enableCpuMemArena: false, enableMemPattern: false };
  recSession = await ort.InferenceSession.create(recData, sessionOpts);

  initialized = true;
  post({ type: 'PROGRESS', stage: 'ready', progress: 1.0, message: 'Ready' });
}

async function processOCR(id, imageData) {
  if (!initialized) await initialize();

  post({ type: 'PROGRESS', id, stage: 'recognition', progress: 0.5, message: 'Recognizing...' });
  const text = await recognizeText(imageData);

  const block = {
    text,
    x: 0, y: 0,
    width: imageData.width, height: imageData.height,
    confidence: 1.0,
    readingOrder: 1,
  };

  post({ type: 'RESULT', id, textBlocks: text ? [block] : [], fullText: text });
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'INIT': await initialize(); break;
      case 'OCR': await processOCR(msg.id, msg.imageData); break;
      case 'TERMINATE': self.close(); break;
    }
  } catch (err) {
    post({ type: 'ERROR', id: msg.id, error: err.message });
  }
};
