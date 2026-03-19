/**
 * ndlocr-lite Web Worker
 * レイアウト検出 (DEIMv2) + 文字認識 (PARSeq) をブラウザ内で実行
 * 参考: yuta1984/ndlocrlite-web
 */

import * as ort from 'onnxruntime-web/wasm';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'warning';
ort.env.wasm.proxy = false;

const MODEL_BASE_URL = '/models';
const DB_NAME = 'NDLOCRLiteDB_prsk';
const DB_VERSION = 1;
const STORE_NAME = 'models';
const MODEL_VERSION = '1.0.0';

let layoutSession = null;
let recSession = null;
let charList = [];
const LAYOUT_INPUT_SIZE = 800;
const REC_INPUT_SHAPE = [1, 3, 16, 256]; // parseq-ndl-30 (≤30 chars)
const LINE_CLASS_IDS = new Set([1, 2, 3, 4, 5, 16]);

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

// ─── Layout Detection (DEIMv2) ───

function preprocessLayout(imageData) {
  const { width: ow, height: oh } = imageData;
  const maxWH = Math.max(ow, oh);
  const scale = LAYOUT_INPUT_SIZE / maxWH;
  const srcCanvas = new OffscreenCanvas(ow, oh);
  srcCanvas.getContext('2d').putImageData(imageData, 0, 0);
  const canvas = new OffscreenCanvas(LAYOUT_INPUT_SIZE, LAYOUT_INPUT_SIZE);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(0,0,0)';
  ctx.fillRect(0, 0, LAYOUT_INPUT_SIZE, LAYOUT_INPUT_SIZE);
  ctx.drawImage(srcCanvas, 0, 0, ow, oh, 0, 0, Math.round(ow * scale), Math.round(oh * scale));
  const { data } = ctx.getImageData(0, 0, LAYOUT_INPUT_SIZE, LAYOUT_INPUT_SIZE);
  const mean = [123.675, 116.28, 103.53];
  const std = [58.395, 57.12, 57.375];
  const tensorData = new Float32Array(3 * LAYOUT_INPUT_SIZE * LAYOUT_INPUT_SIZE);
  for (let h = 0; h < LAYOUT_INPUT_SIZE; h++) {
    for (let w = 0; w < LAYOUT_INPUT_SIZE; w++) {
      const px = (h * LAYOUT_INPUT_SIZE + w) * 4;
      for (let c = 0; c < 3; c++)
        tensorData[c * LAYOUT_INPUT_SIZE * LAYOUT_INPUT_SIZE + h * LAYOUT_INPUT_SIZE + w] = (data[px + c] - mean[c]) / std[c];
    }
  }
  return {
    tensor: new ort.Tensor('float32', tensorData, [1, 3, LAYOUT_INPUT_SIZE, LAYOUT_INPUT_SIZE]),
    maxWH, ow, oh,
  };
}

async function detectLayout(imageData) {
  const { tensor, maxWH, ow, oh } = preprocessLayout(imageData);
  const inputs = { [layoutSession.inputNames[0]]: tensor };
  if (layoutSession.inputNames.length > 1) {
    inputs[layoutSession.inputNames[1]] = new ort.Tensor(
      'int64', BigInt64Array.from([BigInt(LAYOUT_INPUT_SIZE), BigInt(LAYOUT_INPUT_SIZE)]), [1, 2]
    );
  }
  const output = await layoutSession.run(inputs);
  const names = layoutSession.outputNames;
  const classIds = output[names[0]].data;
  const bboxes = output[names[1]].data;
  const scores = output[names[2]].data;
  const charCounts = names.length > 3 ? output[names[3]].data : null;
  const scaleX = maxWH / LAYOUT_INPUT_SIZE;
  const scaleY = maxWH / LAYOUT_INPUT_SIZE;
  const lines = [];
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] < 0.3) continue;
    const cls = Number(classIds[i]) - 1;
    if (!LINE_CLASS_IDS.has(cls)) continue;
    const bh = (bboxes[i * 4 + 3] - bboxes[i * 4 + 1]) * scaleY;
    const dh = bh * 0.02;
    const x1 = Math.max(0, Math.round(bboxes[i * 4 + 0] * scaleX));
    const y1 = Math.max(0, Math.round(bboxes[i * 4 + 1] * scaleY - dh));
    const x2 = Math.min(ow, Math.round(bboxes[i * 4 + 2] * scaleX));
    const y2 = Math.min(oh, Math.round(bboxes[i * 4 + 3] * scaleY + dh));
    const w = x2 - x1, h = y2 - y1;
    if (w >= 10 && h >= 10)
      lines.push({ x: x1, y: y1, width: w, height: h, confidence: scores[i], charCountCategory: charCounts ? charCounts[i] : 100 });
  }
  lines.sort((a, b) => b.confidence - a.confidence);
  const keep = [];
  for (const d of lines) {
    if (keep.every(k => iou(k, d) < 0.5)) keep.push(d);
  }
  keep.sort((a, b) => a.y - b.y);
  return keep;
}

function iou(a, b) {
  const ax2 = a.x + a.width, ay2 = a.y + a.height;
  const bx2 = b.x + b.width, by2 = b.y + b.height;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter === 0) return 0;
  return inter / (a.width * a.height + b.width * b.height - inter);
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

function cropRegion(imageData, region) {
  const src = new OffscreenCanvas(imageData.width, imageData.height);
  src.getContext('2d').putImageData(imageData, 0, 0);
  const canvas = new OffscreenCanvas(region.width, region.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
  return ctx.getImageData(0, 0, region.width, region.height);
}

// ─── Worker message handling ───

let initialized = false;

async function initialize() {
  if (initialized) return;
  post({ type: 'PROGRESS', stage: 'loading', progress: 0.02, message: 'Loading charset...' });
  await loadCharset();

  const progresses = { layout: 0, rec: 0 };
  const report = () => {
    const avg = (progresses.layout + progresses.rec) / 2;
    post({ type: 'PROGRESS', stage: 'loading', progress: 0.05 + avg * 0.7, message: `Loading models... ${Math.round(avg * 100)}%` });
  };

  const [layoutData, recData] = await Promise.all([
    loadModel('layout', `${MODEL_BASE_URL}/deim-s-1024x1024.onnx`, p => { progresses.layout = p; report(); }),
    loadModel('rec30', `${MODEL_BASE_URL}/parseq-ndl-30.onnx`, p => { progresses.rec = p; report(); }),
  ]);

  post({ type: 'PROGRESS', stage: 'init_session', progress: 0.78, message: 'Preparing layout model...' });
  const sessionOpts = { executionProviders: ['wasm'], logSeverityLevel: 4, graphOptimizationLevel: 'basic', enableCpuMemArena: false, enableMemPattern: false };
  layoutSession = await ort.InferenceSession.create(layoutData, sessionOpts);

  post({ type: 'PROGRESS', stage: 'init_session', progress: 0.90, message: 'Preparing recognition model...' });
  recSession = await ort.InferenceSession.create(recData, sessionOpts);

  initialized = true;
  post({ type: 'PROGRESS', stage: 'ready', progress: 1.0, message: 'Ready' });
}

async function processOCR(id, imageData) {
  if (!initialized) await initialize();

  post({ type: 'PROGRESS', id, stage: 'layout', progress: 0.1, message: 'Detecting text regions...' });
  const regions = await detectLayout(imageData);

  if (regions.length === 0) {
    post({ type: 'RESULT', id, textBlocks: [], fullText: '' });
    return;
  }

  const srcCanvas = new OffscreenCanvas(imageData.width, imageData.height);
  srcCanvas.getContext('2d').putImageData(imageData, 0, 0);

  const textBlocks = [];
  for (let i = 0; i < regions.length; i++) {
    post({ type: 'PROGRESS', id, stage: 'recognition', progress: 0.3 + (i / regions.length) * 0.6, message: `Recognizing ${i + 1}/${regions.length}...` });
    const cropped = cropRegion(imageData, regions[i]);
    const text = await recognizeText(cropped);
    textBlocks.push({
      text,
      x: regions[i].x,
      y: regions[i].y,
      width: regions[i].width,
      height: regions[i].height,
      confidence: regions[i].confidence,
      readingOrder: i + 1,
    });
  }

  const fullText = textBlocks.filter(b => b.text).map(b => b.text).join('\n');
  post({ type: 'RESULT', id, textBlocks, fullText });
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
