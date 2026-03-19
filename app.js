/**
 * SEKAI recorder - app.js
 * OCR: サーバー (PaddleOCR) または ブラウザ (ndlocr-lite / GPU)
 */

import { parseGameResult } from './ocr-postprocess.js';

// ========================================
// State
// ========================================
const state = {
  files: [],
  isProcessing: false,
  results: [],
  songDatabase: null,
  user: null,
  token: localStorage.getItem('prsk_ocr_token') || null,
  uploadPending: 0,
  uploadComplete: false,
  ocrMode: localStorage.getItem('prsk_ocr_mode') || 'server',
};

let fileIdCounter = 0;

// ========================================
// DOM Elements
// ========================================
const $ = (sel) => document.querySelector(sel);
const dropZone = $('#drop-zone');
const fileInput = $('#file-input');
const previewSection = $('#preview-section');
const previewGrid = $('#preview-grid');
const langSection = $('#lang-section');
const resultsSection = $('#results-section');
const resultsList = $('#results-list');
const ocrBtn = $('#ocr-btn');
const clearBtn = $('#clear-btn');
const copyAllBtn = $('#copy-all-btn');
const ocrModeSelect = $('#ocr-mode');
const modelStatus = $('#model-status');
const modelStatusText = $('#model-status-text');
const authArea = $('#auth-area');
const authUser = $('#auth-user');
const authLoginBtn = $('#auth-login-btn');
const authRegisterBtn = $('#auth-register-btn');
const authLogoutBtn = $('#auth-logout-btn');
const recordsLink = $('#records-link');
const authModal = $('#auth-modal');
const authModalBackdrop = $('#auth-modal-backdrop');
const authModalTitle = $('#auth-modal-title');
const authForm = $('#auth-form');
const authUsername = $('#auth-username');
const authPassword = $('#auth-password');
const authError = $('#auth-error');
const authModalCancel = $('#auth-modal-cancel');
const authSubmit = $('#auth-submit');
const manualEntryBtn = $('#manual-entry-btn');
const manualModal = $('#manual-modal');
const manualModalBackdrop = $('#manual-modal-backdrop');
const manualSearch = $('#manual-search');
const manualSearchResults = $('#manual-search-results');
const manualSelected = $('#manual-selected');
const manualSelectedTitle = $('#manual-selected-title');
const manualDifficulty = $('#manual-difficulty');
const manualGreat = $('#manual-great');
const manualGood = $('#manual-good');
const manualBad = $('#manual-bad');
const manualMiss = $('#manual-miss');
const manualError = $('#manual-error');
const manualModalCancel = $('#manual-modal-cancel');
const manualSubmit = $('#manual-submit');

// ========================================
// API (認証付き)
// ========================================
async function apiCall(path, options = {}) {
  const headers = { ...options.headers, 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(path, { ...options, headers });
  const data = res.ok ? await res.json().catch(() => ({})) : null;
  if (!res.ok) {
    const err = new Error(data?.detail || res.statusText || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function saveRecord(parsed, takenAt) {
  if (!state.token || !parsed?.songId || !parsed?.difficulty || parsed?.judgmentsSumError) return null;
  const j = parsed.judgments;
  if (typeof j?.PERFECT !== 'number' || typeof j?.GREAT !== 'number' || typeof j?.GOOD !== 'number' ||
      typeof j?.BAD !== 'number' || typeof j?.MISS !== 'number') return null;
  const point = (j.PERFECT * 3) + (j.GREAT * 2) + (j.GOOD * 1);
  try {
    return await apiCall('/api/records', {
      method: 'POST',
      body: JSON.stringify({
        song_id: parsed.songId,
        difficulty: parsed.difficulty,
        perfect: j.PERFECT,
        great: j.GREAT,
        good: j.GOOD,
        bad: j.BAD,
        miss: j.MISS,
        point,
        taken_at: takenAt || null,
      }),
    });
  } catch (e) {
    console.warn('Failed to save record', e);
    return null;
  }
}

/** ML用データセットに1件追加（OCR結果 or 手動入力） */
async function saveDataset(payload) {
  const res = await fetch('/api/dataset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.detail || res.statusText);
  }
  return res.json();
}

window.__addToDataset = async function (displayIndex) {
  const results = state.sortedResults || state.results;
  const r = results[displayIndex];
  if (!r?.parsed?.songId || r.parsed.judgmentsSumError) return;
  const j = r.parsed.judgments;
  if (typeof j?.PERFECT !== 'number') return;
  const point = (j.PERFECT * 3) + (j.GREAT * 2) + (j.GOOD * 1);
  const payload = {
    source: 'ocr',
    image_base64: r.entry?.dataUrl || null,
    raw_text: r.rawText || '',
    song_id: r.parsed.songId,
    song_title: r.parsed.songTitle || '',
    difficulty: (r.parsed.difficulty || '').toLowerCase(),
    perfect: j.PERFECT,
    great: j.GREAT,
    good: j.GOOD,
    bad: j.BAD,
    miss: j.MISS,
    point,
  };
  try {
    await saveDataset(payload);
    const feedback = $(`#dataset-feedback-${displayIndex}`);
    if (feedback) {
      feedback.classList.add('show');
      setTimeout(() => feedback.classList.remove('show'), 2000);
    }
  } catch (e) {
    console.error(e);
    alert('データセットの保存に失敗しました: ' + e.message);
  }
};

// ========================================
// File Handling
// ========================================

function handleFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  const imageFiles = Array.from(fileList).filter(f => f && f.type && f.type.startsWith('image/'));
  if (imageFiles.length === 0) return;

  // モバイル: 同じファイルを再選択できるよう、処理後に input をリセットする
  const input = document.getElementById('file-input');
  if (input) input.value = '';

  state.uploadPending += imageFiles.length;
  state.uploadComplete = false;

  imageFiles.forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const entry = {
        id: ++fileIdCounter,
        file,
        dataUrl: e.target.result,
      };
      state.files.push(entry);
      renderPreview();
      state.uploadPending -= 1;
      if (state.uploadPending <= 0) {
        state.uploadComplete = true;
        renderPreview();
        ocrBtn.disabled = false;
      }
    };
    reader.onerror = () => renderPreview();
    reader.readAsDataURL(file);
  });
}

function removeFile(id) {
  state.files = state.files.filter(f => f.id !== id);
  renderPreview();
}

function clearFiles() {
  state.files = [];
  state.results = [];
  renderPreview();
  resultsSection.style.display = 'none';
  resultsList.innerHTML = '';
}

// ========================================
// Drag & Drop / File Select
// ========================================

let _fileInputPending = null;
function onFileInputChange(e) {
  const files = e.target && e.target.files;
  if (!files || files.length === 0) return;
  const list = Array.from(files);
  if (_fileInputPending) clearTimeout(_fileInputPending);
  _fileInputPending = setTimeout(() => {
    _fileInputPending = null;
    handleFiles(list);
  }, 10);
}

if (fileInput) {
  fileInput.addEventListener('change', onFileInputChange);
  fileInput.addEventListener('input', onFileInputChange);
}

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFiles(e.dataTransfer.files);
});

// ========================================
// Preview Rendering
// ========================================

function renderPreview() {
  const hasFiles = state.files.length > 0;
  previewSection.style.display = hasFiles ? '' : 'none';
  if (langSection) langSection.style.display = hasFiles ? '' : 'none';

  previewGrid.innerHTML = state.files.map(entry => `
    <div class="preview-card" data-id="${entry.id}">
      <img src="${entry.dataUrl}" alt="${entry.file.name}">
      <button class="remove-btn" onclick="window.__removeFile(${entry.id})" title="削除">✕</button>
      <div class="file-name">${entry.file.name}</div>
    </div>
  `).join('');
}

// Expose for inline onclick
window.__removeFile = removeFile;

// ========================================
// OCR Mode: Server (PaddleOCR) / Browser (Tesseract.js)
// ========================================

function updateModelStatus() {
  if (!modelStatus || !modelStatusText) return;
  const isBrowser = state.ocrMode === 'browser';
  modelStatus.querySelector('.status-dot').className = 'status-dot ready';
  modelStatusText.textContent = isBrowser
    ? 'ブラウザOCR (Tesseract.js) 選択中'
    : 'サーバーOCR 準備完了 (PaddleOCR)';
}

// ─── PARSeq (メインスレッド ONNX Runtime) ───
let _parseqSession = null;
let _parseqCharList = [];
let _parseqInitPromise = null;
const PARSEQ_INPUT = [1, 3, 16, 256];

async function initParseq() {
  if (_parseqSession) return;
  if (_parseqInitPromise) return _parseqInitPromise;
  _parseqInitPromise = (async () => {
    console.log('[PARSeq] Loading ONNX Runtime...');
    const ort = await import('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.wasm.min.mjs');
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'warning';
    ort.env.wasm.proxy = false;
    window._parseqOrt = ort;

    console.log('[PARSeq] Loading charset...');
    try {
      const res = await fetch('/config/NDLmoji.yaml');
      const text = await res.text();
      const m = text.match(/charset_train:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) {
        const raw = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        _parseqCharList = [...raw];
      }
      console.log('[PARSeq] charset loaded:', _parseqCharList.length, 'chars');
    } catch (e) { console.warn('[PARSeq] charset load failed:', e); }

    console.log('[PARSeq] Loading model...');
    const modelRes = await fetch('/models/parseq-ndl-30.onnx');
    if (!modelRes.ok) throw new Error(`Model fetch failed: ${modelRes.status}`);
    const modelBuf = await modelRes.arrayBuffer();

    console.log('[PARSeq] Creating session...');
    const opts = { executionProviders: ['wasm'], logSeverityLevel: 4 };
    _parseqSession = await ort.InferenceSession.create(modelBuf, opts);
    console.log('[PARSeq] Ready');
  })();
  return _parseqInitPromise;
}

function parseqRecognize(imageData) {
  const ort = window._parseqOrt;
  const [, ch, h, w] = PARSEQ_INPUT;
  const iw = imageData.width, ih = imageData.height;

  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = iw; tmpCanvas.height = ih;
  tmpCanvas.getContext('2d').putImageData(imageData, 0, 0);

  let srcCanvas = tmpCanvas;
  if (ih > iw) {
    srcCanvas = document.createElement('canvas');
    srcCanvas.width = ih; srcCanvas.height = iw;
    const ctx = srcCanvas.getContext('2d');
    ctx.translate(ih / 2, iw / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.translate(-iw / 2, -ih / 2);
    ctx.drawImage(tmpCanvas, 0, 0);
  }

  const resizeCanvas = document.createElement('canvas');
  resizeCanvas.width = w; resizeCanvas.height = h;
  resizeCanvas.getContext('2d').drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, 0, 0, w, h);
  const { data } = resizeCanvas.getContext('2d').getImageData(0, 0, w, h);
  const tensorData = new Float32Array(ch * h * w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = (y * w + x) * 4;
      for (let c = 0; c < ch; c++)
        tensorData[c * h * w + y * w + x] = 2.0 * (data[px + c] / 255.0 - 0.5);
    }
  }
  const tensor = new ort.Tensor('float32', tensorData, PARSEQ_INPUT);
  return _parseqSession.run({ [_parseqSession.inputNames[0]]: tensor }).then(output => {
    const outTensor = output[_parseqSession.outputNames[0]];
    const logits = Array.from(outTensor.data).map(v => typeof v === 'bigint' ? Number(v) : v);
    const [, seqLen, vocabSize] = outTensor.dims;
    console.log(`[PARSeq decode] dims=[${outTensor.dims}] charset=${_parseqCharList.length}`);
    const ids = [];
    for (let i = 0; i < seqLen; i++) {
      const slice = logits.slice(i * vocabSize, (i + 1) * vocabSize);
      const maxVal = Math.max(...slice);
      const maxIdx = slice.indexOf(maxVal);
      if (i < 3) console.log(`[PARSeq decode] pos${i}: maxIdx=${maxIdx} maxVal=${maxVal.toFixed(3)}`);
      if (maxIdx === 0) break;
      if (maxIdx < 4) continue;
      ids.push(maxIdx - 1);
    }
    const chars = [];
    let prev = -1;
    for (const id of ids) {
      if (id !== prev && id < _parseqCharList.length) { chars.push(_parseqCharList[id]); prev = id; }
    }
    console.log(`[PARSeq decode] ids=${JSON.stringify(ids.slice(0,10))} chars=${JSON.stringify(chars.join(''))}`);
    return chars.join('').trim();
  });
}

/**
 * 画像を曲名領域とスコア領域に crop する。
 * server.py の _apply_black_mask と同じ座標系:
 *   曲名: [0 : h/4, 0 : w/2]   （左上 1/4）
 *   スコア: [h/2 : h, 0 : w/3] （左下 1/3）
 */
function splitImageRegions(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = img.naturalWidth;
      const h = img.naturalHeight;

      // 曲名領域 (左上)
      const titleW = Math.floor(w / 2);
      const titleH = Math.floor(h / 4);
      const titleCanvas = document.createElement('canvas');
      titleCanvas.width = titleW;
      titleCanvas.height = titleH;
      titleCanvas.getContext('2d').drawImage(img, 0, 0, titleW, titleH, 0, 0, titleW, titleH);
      const titleImageData = titleCanvas.getContext('2d').getImageData(0, 0, titleW, titleH);

      // スコア領域 (左下) — グレースケール + コントラスト強調
      const scoreW = Math.floor(w / 3);
      const scoreH = h - Math.floor(h / 2);
      const scoreY = Math.floor(h / 2);
      const scoreCanvas = document.createElement('canvas');
      scoreCanvas.width = scoreW;
      scoreCanvas.height = scoreH;
      const scoreCtx = scoreCanvas.getContext('2d');
      scoreCtx.drawImage(img, 0, scoreY, scoreW, scoreH, 0, 0, scoreW, scoreH);
      const sd = scoreCtx.getImageData(0, 0, scoreW, scoreH);
      const d = sd.data;
      for (let i = 0; i < d.length; i += 4) {
        let gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        gray = Math.min(255, Math.max(0, (gray - 128) * 1.5 + 128));
        d[i] = d[i + 1] = d[i + 2] = gray;
      }
      scoreCtx.putImageData(sd, 0, 0);

      console.log(`[split] 元画像 ${w}x${h} → 曲名 ${titleW}x${titleH}, スコア ${scoreW}x${scoreH} (y=${scoreY})`);

      titleCanvas.toBlob((titleBlob) => {
        if (!titleBlob) { reject(new Error('titleCanvas toBlob failed')); return; }
        scoreCanvas.toBlob((scoreBlob) => {
          if (!scoreBlob) { reject(new Error('scoreCanvas toBlob failed')); return; }
          resolve({ titleBlob, titleImageData, scoreBlob, fullWidth: w, fullHeight: h });
        }, 'image/png');
      }, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url;
  });
}

/**
 * ブラウザ内OCR（3並列: 曲名PARSeq + 曲名Tesseract jpn+eng + スコアTesseract eng）
 * 結果マージ: PARSeq曲名 → Tesseract曲名(難易度+フォールバック) → スコア
 */
async function ocrViaBrowser(file, onProgress) {
  if (!window.Tesseract) {
    throw new Error('Tesseract.js が読み込まれていません');
  }

  const start = performance.now();
  onProgress?.(5);

  // PARSeq 初期化（失敗しても続行）
  let parseqAvailable = false;
  try {
    await initParseq();
    parseqAvailable = !!_parseqSession;
    console.log('[OCR] PARSeq available:', parseqAvailable);
  } catch (e) {
    console.warn('[OCR] PARSeq 初期化失敗 (Tesseract フォールバック):', e.message);
    _parseqInitPromise = null;
  }

  const { titleBlob, titleImageData, scoreBlob, fullWidth, fullHeight } = await splitImageRegions(file);
  onProgress?.(10);

  // ② 曲名 Tesseract jpn+eng + ③ スコア Tesseract eng（並列）
  const titleTessPromise = (async () => {
    const w = await window.Tesseract.createWorker('jpn+eng', 1, {
      logger: (m) => {
        if (typeof m.progress !== 'number') return;
        if (m.status === 'recognizing text') onProgress?.(10 + Math.round(m.progress * 30));
      },
    });
    await w.setParameters({ tessedit_pageseg_mode: '6' });
    const res = await w.recognize(titleBlob);
    await w.terminate();
    return res;
  })();

  const scorePromise = (async () => {
    const w = await window.Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (typeof m.progress !== 'number') return;
        if (m.status === 'recognizing text') onProgress?.(40 + Math.round(m.progress * 50));
      },
    });
    await w.setParameters({ tessedit_pageseg_mode: '6' });
    const res = await w.recognize(scoreBlob);
    await w.terminate();
    return res;
  })();

  const [titleTessResult, scoreResult] = await Promise.all([titleTessPromise, scorePromise]);
  onProgress?.(92);

  // ① PARSeq: Tesseract が検出した行 bbox で title crop を再 crop → 行単位で認識
  const parseqBlocks = [];
  if (parseqAvailable && titleTessResult.data?.lines?.length) {
    const titleCanvas = document.createElement('canvas');
    titleCanvas.width = titleImageData.width;
    titleCanvas.height = titleImageData.height;
    titleCanvas.getContext('2d').putImageData(titleImageData, 0, 0);

    for (let li = 0; li < titleTessResult.data.lines.length; li++) {
      const ln = titleTessResult.data.lines[li];
      const b = ln.bbox;
      console.log(`[PARSeq] 行${li} bbox:`, b, 'text:', (ln.text||'').trim());
      if (!b || b.x1 - b.x0 < 10 || b.y1 - b.y0 < 5) { console.log(`[PARSeq] 行${li} skip (small)`); continue; }
      const pad = 4;
      const x = Math.max(0, b.x0 - pad);
      const y = Math.max(0, b.y0 - pad);
      const w = Math.min(titleImageData.width - x, b.x1 - b.x0 + pad * 2);
      const h = Math.min(titleImageData.height - y, b.y1 - b.y0 + pad * 2);
      const lineCanvas = document.createElement('canvas');
      lineCanvas.width = w;
      lineCanvas.height = h;
      lineCanvas.getContext('2d').drawImage(titleCanvas, x, y, w, h, 0, 0, w, h);
      const lineImageData = lineCanvas.getContext('2d').getImageData(0, 0, w, h);
      try {
        const text = await parseqRecognize(lineImageData);
        console.log(`[PARSeq] 行${li} (${w}x${h}) →`, JSON.stringify(text));
        if (text) {
          parseqBlocks.push({ text, x, y, width: w, height: h });
        }
      } catch (e) {
        console.warn(`[PARSeq] 行${li} error:`, e.message);
      }
    }
  }
  onProgress?.(95);

  // --- 結果マージ ---
  let order = 1;

  // PARSeq 曲名ブロック（先頭配置 → findBestSongMatch で最優先マッチ）
  const parseqMapped = parseqBlocks.map(b => ({
    ...b, confidence: 1.0, readingOrder: order++,
  }));
  if (parseqMapped.length) {
    console.log('[OCR] 曲名 PARSeq:', parseqMapped.map(b => b.text));
  } else {
    console.log('[OCR] 曲名 PARSeq: (結果なし)');
  }

  // Tesseract 曲名ブロック（難易度検出 + 英数字曲名フォールバック）
  const titleTessBlocks = (titleTessResult.data?.lines || []).map((ln) => ({
    text: (ln.text || '').trim(),
    x: ln.bbox?.x0 ?? 0,
    y: ln.bbox?.y0 ?? 0,
    width: ln.bbox ? (ln.bbox.x1 - ln.bbox.x0) : 0,
    height: ln.bbox ? (ln.bbox.y1 - ln.bbox.y0) : 30,
    confidence: ln.confidence ?? 0.9,
    readingOrder: order++,
  })).filter(l => l.text);
  console.log('[OCR] 曲名 Tesseract:', titleTessBlocks.map(b => b.text));

  // スコアブロック（Y座標オフセット）
  const scoreOffsetY = Math.floor(fullHeight / 2);
  const scoreLines = (scoreResult.data?.lines || []).map((ln) => ({
    text: (ln.text || '').trim(),
    x: ln.bbox?.x0 ?? 0,
    y: (ln.bbox?.y0 ?? 0) + scoreOffsetY,
    width: ln.bbox ? (ln.bbox.x1 - ln.bbox.x0) : 0,
    height: ln.bbox ? (ln.bbox.y1 - ln.bbox.y0) : 30,
    confidence: ln.confidence ?? 0.9,
    readingOrder: order++,
  })).filter(l => l.text);
  console.log('[OCR] スコア Tesseract:', scoreLines.map(b => b.text));

  const allBlocks = [...parseqMapped, ...titleTessBlocks, ...scoreLines];
  const fullText = allBlocks.map(b => b.text).join('\n');
  const elapsedMs = Math.round(performance.now() - start);

  return {
    textBlocks: allBlocks,
    fullText,
    processingTime: elapsedMs,
    imageDateTime: null,
  };
}

/**
 * サーバー経由でOCR実行
 * @param {File} file
 * @returns {Promise<Object>} { textBlocks, fullText, processingTime }
 */
async function ocrViaServer(file) {
  const formData = new FormData();
  formData.append('file', file);

  const start = performance.now();
  const res = await fetch('/ocr', {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`OCR API error: ${res.status}`);
  }

  const data = await res.json();
  const elapsedMs = Math.round(performance.now() - start);

  return {
    textBlocks: data.textBlocks || [],
    fullText: data.fullText || '',
    processingTime: data.processingTime ?? elapsedMs,
    imageDateTime: data.imageDateTime || null,
  };
}

// ========================================
// OCR Processing
// ========================================

async function processImages() {
  if (state.files.length === 0 || state.isProcessing) return;
  if (!state.uploadComplete) return; // 画像の読み込み完了前は実行させない

  state.isProcessing = true;
  ocrBtn.disabled = true;

  if (previewSection) previewSection.style.display = 'none';

  // Show progress UI
  resultsSection.style.display = '';
  resultsList.innerHTML = renderProgressUI(state.files);

  state.results = [];

  for (let i = 0; i < state.files.length; i++) {
    const entry = state.files[i];
    const startTime = performance.now();

    updateProgressItem(i, 'active', state.ocrMode === 'browser' ? 5 : 30);

    try {
      const ocrResult = state.ocrMode === 'browser'
        ? await ocrViaBrowser(entry.file, (p) => updateProgressItem(i, 'active', p))
        : await ocrViaServer(entry.file);
      if (state.ocrMode !== 'browser') updateProgressItem(i, 'active', 80);

      // プロセカ特化の後処理
      let parsed = null;
      if (state.songDatabase && (state.songDatabase.songs?.length > 0 || (Array.isArray(state.songDatabase) && state.songDatabase.length > 0))) {
        parsed = parseGameResult(ocrResult, state.songDatabase);
      }

      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

      let recordSaved = null;
      if (state.token && parsed && !parsed.judgmentsSumError && parsed.songId != null && parsed.difficulty) {
        try {
          recordSaved = await saveRecord(parsed, ocrResult.imageDateTime || null);
        } catch (_) {}
      }

      // デフォルトで ML 用データセットに追加
      if (parsed && parsed.songId != null && !parsed.judgmentsSumError && !parsed.songError && parsed.judgments) {
        const j = parsed.judgments;
        if (typeof j.PERFECT === 'number' && typeof j.GREAT === 'number' && typeof j.GOOD === 'number' &&
            typeof j.BAD === 'number' && typeof j.MISS === 'number') {
          const point = (j.PERFECT * 3) + (j.GREAT * 2) + (j.GOOD * 1);
          const payload = {
            source: 'ocr',
            image_base64: entry.dataUrl || null,
            raw_text: ocrResult.fullText || '',
            song_id: parsed.songId,
            song_title: parsed.songTitle || '',
            difficulty: (parsed.difficulty || '').toLowerCase(),
            perfect: j.PERFECT,
            great: j.GREAT,
            good: j.GOOD,
            bad: j.BAD,
            miss: j.MISS,
            point,
          };
          saveDataset(payload).catch((e) => console.warn('Failed to save dataset', e));
        }
      }

      state.results.push({
        entry,
        rawText: ocrResult.fullText || '',
        parsed: parsed,
        elapsed,
        error: null,
        recordSaved: recordSaved?.saved ?? false,
      });
      updateProgressItem(i, 'done', 100);
    } catch (err) {
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      state.results.push({ entry, parsed: null, rawText: '', elapsed, error: err.message });
      updateProgressItem(i, 'done', 100);
    }
  }

  // エラー・総和エラー・曲名エラーが出たものを結果の一番上に表示
  const sorted = [...state.results].sort((a, b) => {
    const aErr = !!(a.error || a.parsed?.judgmentsSumError || a.parsed?.songError);
    const bErr = !!(b.error || b.parsed?.judgmentsSumError || b.parsed?.songError);
    if (aErr && !bErr) return -1;
    if (!aErr && bErr) return 1;
    return 0;
  });
  renderResults(sorted);

  state.isProcessing = false;
  ocrBtn.disabled = false;
}

// ========================================
// Progress UI
// ========================================

function renderProgressUI(files) {
  const items = files.map((entry, i) => `
    <div class="progress-item" id="progress-item-${i}">
      <span class="progress-item-name">${entry.file.name}</span>
      <div class="progress-bar-container">
        <div class="progress-bar" id="progress-bar-${i}"></div>
      </div>
      <span class="progress-status" id="progress-status-${i}">待機</span>
    </div>
  `).join('');

  return `
    <div class="progress-overlay" id="progress-overlay">
      <div class="progress-title">
        <div class="progress-spinner"></div>
        OCR処理中...
      </div>
      <div class="progress-items">${items}</div>
    </div>
  `;
}

function updateProgressItem(index, status, progress) {
  const item = $(`#progress-item-${index}`);
  const bar = $(`#progress-bar-${index}`);
  const statusEl = $(`#progress-status-${index}`);
  if (!item || !bar || !statusEl) return;

  item.className = `progress-item ${status}`;
  bar.style.width = `${progress}%`;

  if (status === 'active') {
    statusEl.textContent = `${progress}%`;
  } else if (status === 'done') {
    statusEl.textContent = '✓';
  }
}

// ========================================
// Results Rendering
// ========================================

function renderResults(results) {
  state.sortedResults = results;
  resultsList.innerHTML = results.map((r, i) => {
    let parsedHtml = '';
    let rawText = r.rawText || '';
    let copyText = rawText;

    if (r.parsed) {
      const { songTitle, matchConfidence, difficulty, judgments, judgmentsSumError, songError, point, rawText: rt } = r.parsed;
      rawText = rt;

      const confClass = matchConfidence >= 0.8 ? 'conf-high' : (matchConfidence >= 0.4 ? 'conf-med' : 'conf-low');
      const difficultyLabel = difficulty ? `難易度: ${difficulty.toUpperCase()}` : '';

      const p = (key) => (typeof judgments[key] === 'number' ? judgments[key] : 0);
      const hasValidNumbers = !judgmentsSumError && ['PERFECT', 'GREAT', 'GOOD', 'BAD', 'MISS'].every(k => typeof judgments[k] === 'number');
      const isAllPerfect = hasValidNumbers && p('MISS') === 0 && p('BAD') === 0 && p('GOOD') === 0 && p('GREAT') === 0;
      const isFullCombo = hasValidNumbers && p('MISS') === 0 && p('BAD') === 0 && p('GOOD') === 0;
      const badgeClass = isAllPerfect ? 'badge-all-perfect' : (isFullCombo ? 'badge-full-combo' : '');

      const judgmentHtml = ['PERFECT', 'GREAT', 'GOOD', 'BAD', 'MISS'].map(j => `
        <div class="judgment-item">
          <span class="judgment-label ${j.toLowerCase()}">${j}</span>
          <span class="judgment-value">${judgments[j]}</span>
        </div>
      `).join('');

      let badgeHtml = '';
      if (badgeClass) {
        const label = isAllPerfect ? 'ALL PERFECT' : 'FULL COMBO';
        badgeHtml = `<div class="result-badge ${badgeClass}">${label}</div>`;
      }

      parsedHtml = `
        <div class="parsed-result">
          <div class="song-match">
            <span class="match-label">推測される楽曲名:</span>
            <span class="match-title">${escapeHtml(songTitle)}</span>
            <span class="match-conf ${confClass}">信頼度: ${Math.round(matchConfidence * 100)}%</span>
          </div>
          ${difficultyLabel ? `<div class="result-difficulty">${escapeHtml(difficultyLabel)}</div>` : ''}
          ${judgmentsSumError ? '<div class="result-sum-error">数字の総和が総ノーツ数と一致しません（数字または難易度の認識エラー）</div>' : ''}
          ${songError ? '<div class="result-sum-error">曲名を特定できませんでした</div>' : ''}
          ${point != null && !judgmentsSumError ? `<div class="result-point">Point: <strong>${point.toLocaleString()}</strong></div>` : ''}
          ${r.recordSaved ? '<div class="result-record-saved">記録を保存しました</div>' : ''}
          ${badgeHtml}
          <div class="judgments-grid">
            ${judgmentHtml}
          </div>
        </div>
      `;

      copyText = `曲名: ${songTitle}\n`;
      copyText += ['PERFECT', 'GREAT', 'GOOD', 'BAD', 'MISS'].map(j => `${j}: ${judgments[j]}`).join('\n');
    }

    return `
      <div class="result-card" id="result-card-${i}">
        <div class="result-card-header">
          <img class="result-thumb" src="${r.entry.dataUrl}" alt="${r.entry.file.name}">
          <div class="result-info">
            <div class="result-filename">${r.entry.file.name}</div>
            <div class="result-meta">
              <span>⏱ ${r.elapsed}秒</span>
            </div>
          </div>
        </div>
        <div class="result-card-body">
          ${r.error ? `<div class="result-text error">エラー: ${r.error}</div>` : ''}
          ${parsedHtml}
          <div class="raw-toggle">
            <button class="btn btn-ghost btn-sm" onclick="window.__toggleRawText(${i})" id="raw-toggle-btn-${i}">生テキストを表示</button>
          </div>
          <div class="result-text raw-text-container" id="result-text-${i}" style="display: none;" data-copy="${escapeHtml(copyText)}">${escapeHtml(rawText || 'テキストが検出されませんでした')}</div>
        </div>
        <div class="result-actions">
          <span class="copy-feedback" id="copy-feedback-${i}">コピーしました</span>
          <button class="btn btn-ghost" onclick="window.__copyResult(${i})">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            抽出結果をコピー
          </button>
        </div>
      </div>
    `;
  }).join('');
}

window.__toggleRawText = function (index) {
  const el = $(`#result-text-${index}`);
  const btn = $(`#raw-toggle-btn-${index}`);
  if (el.style.display === 'none') {
    el.style.display = 'block';
    btn.textContent = '生テキストを隠す';
  } else {
    el.style.display = 'none';
    btn.textContent = '生テキストを表示';
  }
};

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ========================================
// Copy Functions
// ========================================

window.__copyResult = function (index) {
  const textEl = $(`#result-text-${index}`);
  if (!textEl) return;

  const copyText = textEl.dataset.copy || textEl.textContent;

  navigator.clipboard.writeText(copyText).then(() => {
    showCopyFeedback(index);
  }).catch(() => {
    const range = document.createRange();
    range.selectNodeContents(textEl);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.execCommand('copy');
    window.getSelection().removeAllRanges();
    showCopyFeedback(index);
  });
};

function showCopyFeedback(index) {
  const feedback = $(`#copy-feedback-${index}`);
  if (!feedback) return;
  feedback.classList.add('show');
  setTimeout(() => feedback.classList.remove('show'), 1500);
}

function copyAllResults() {
  const textEls = document.querySelectorAll('.result-text');
  const allText = Array.from(textEls).map(el => el.dataset.copy || el.textContent).join('\n\n---\n\n');
  navigator.clipboard.writeText(allText).then(() => {
    copyAllBtn.textContent = 'コピーしました ✓';
    setTimeout(() => {
      copyAllBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        すべてコピー
      `;
    }, 1500);
  });
}

// ========================================
// Event Listeners
// ========================================

ocrBtn.addEventListener('click', processImages);
clearBtn.addEventListener('click', clearFiles);
copyAllBtn.addEventListener('click', copyAllResults);

// ========================================
// Auth UI
// ========================================
function renderAuthArea() {
  if (!authUser || !authLoginBtn || !authRegisterBtn || !authLogoutBtn) return;
  if (state.user) {
    authUser.textContent = state.user.username;
    authUser.style.display = '';
    authLoginBtn.style.display = 'none';
    authRegisterBtn.style.display = 'none';
    authLogoutBtn.style.display = '';
    if (recordsLink) {
      recordsLink.href = `/records/${encodeURIComponent(state.user.username)}`;
    }
  } else {
    authUser.style.display = 'none';
    authLogoutBtn.style.display = 'none';
    authLoginBtn.style.display = '';
    authRegisterBtn.style.display = '';
    if (recordsLink) {
      // 未ログインの場合は records.html へ（公開URLは username が必要）
      recordsLink.href = 'records.html';
    }
  }
}

function openAuthModal(mode) {
  if (!authModal || !authForm) return;
  authModal.dataset.mode = mode;
  authModalTitle.textContent = mode === 'register' ? '新規登録' : 'ログイン';
  authSubmit.textContent = mode === 'register' ? '登録' : 'ログイン';
  authUsername.value = '';
  authPassword.value = '';
  authError.textContent = '';
  authModal.style.display = 'flex';
  authModal.setAttribute('aria-hidden', 'false');
}

function closeAuthModal() {
  if (!authModal) return;
  authModal.style.display = 'none';
  authModal.setAttribute('aria-hidden', 'true');
}

async function submitAuth(e) {
  e.preventDefault();
  if (authSubmit) authSubmit.disabled = true;
  const mode = authModal?.dataset.mode || 'login';
  const username = (authUsername?.value || '').trim();
  const password = authPassword?.value || '';
  authError.textContent = '';
  if (username.length < 2) {
    authError.textContent = 'ユーザー名は2文字以上です';
    return;
  }
  if (password.length < 6) {
    authError.textContent = 'パスワードは6文字以上です';
    return;
  }
  try {
    const path = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      authError.textContent = data.detail || res.statusText || '失敗しました';
      return;
    }
    if (data.access_token && data.user) {
      state.token = data.access_token;
      state.user = data.user;
      localStorage.setItem('prsk_ocr_token', state.token);
      closeAuthModal();
      renderAuthArea();
    } else {
      authError.textContent = '応答が不正です';
    }
  } catch (err) {
    authError.textContent = err.message || '通信エラー';
  } finally {
    if (authSubmit) authSubmit.disabled = false;
  }
}

// ========================================
// Initialization
// ========================================

async function init() {
  console.log("Loading song database...");
  try {
    const res = await fetch('songDatabase.json');
    if (res.ok) {
      state.songDatabase = await res.json();
      const n = state.songDatabase?.songs?.length ?? 0;
      console.log(`Loaded songDatabase.json: ${n} songs.`);
    } else {
      console.warn("songDatabase.json not found, trying songs.json");
      const fallback = await fetch('songs.json');
      if (fallback.ok) {
        state.songDatabase = await fallback.json();
        console.log(`Loaded songs.json: ${state.songDatabase.length} titles (no totalNoteCount).`);
      }
    }
  } catch (e) {
    console.error("Error loading song database", e);
  }

  if (state.token) {
    try {
      const data = await apiCall('/api/auth/me');
      if (data?.user) state.user = data.user;
      else state.token = null, localStorage.removeItem('prsk_ocr_token');
    } catch (_) {
      state.token = null;
      localStorage.removeItem('prsk_ocr_token');
    }
  }
  renderAuthArea();

  if (authLoginBtn) authLoginBtn.addEventListener('click', () => openAuthModal('login'));
  if (authRegisterBtn) authRegisterBtn.addEventListener('click', () => openAuthModal('register'));
  if (authLogoutBtn) authLogoutBtn.addEventListener('click', () => {
    state.user = null;
    state.token = null;
    localStorage.removeItem('prsk_ocr_token');
    renderAuthArea();
  });
  if (authModalBackdrop) authModalBackdrop.addEventListener('click', closeAuthModal);
  if (authModalCancel) authModalCancel.addEventListener('click', closeAuthModal);
  if (authForm) authForm.addEventListener('submit', submitAuth);

  if (manualEntryBtn) manualEntryBtn.addEventListener('click', openManualModal);
  if (manualModalBackdrop) manualModalBackdrop.addEventListener('click', closeManualModal);
  if (manualModalCancel) manualModalCancel.addEventListener('click', closeManualModal);
  if (manualSearch) manualSearch.addEventListener('input', renderManualSearchResults);
  if (manualSubmit) manualSubmit.addEventListener('click', submitManualEntry);

  // マイページから遷移してきた場合: index.html?manual=1 で手動入力を開く
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('manual') === '1') {
      openManualModal();
    }
  } catch (_) {
    // ignore
  }

  if (ocrModeSelect) {
    ocrModeSelect.value = state.ocrMode;
    ocrModeSelect.addEventListener('change', () => {
      state.ocrMode = ocrModeSelect.value;
      localStorage.setItem('prsk_ocr_mode', state.ocrMode);
      updateModelStatus();
    });
  }
  updateModelStatus();
  ocrBtn.disabled = true; // アップロード完了までは押せない
  ocrBtn.textContent = 'OCR実行';
}

// ========================================
// 手動入力モーダル
// ========================================
state.manualSelectedSong = null;

function openManualModal() {
  if (!manualModal) return;
  state.manualSelectedSong = null;
  if (manualSearch) manualSearch.value = '';
  if (manualSelected) manualSelected.style.display = 'none';
  if (manualSearchResults) manualSearchResults.innerHTML = '';
  if (manualDifficulty) manualDifficulty.value = 'master';
  [manualGreat, manualGood, manualBad, manualMiss].forEach((el) => { if (el) el.value = '0'; });
  if (manualError) manualError.textContent = '';
  manualModal.style.display = 'flex';
  manualModal.setAttribute('aria-hidden', 'false');
  if (manualSearch) manualSearch.focus();
}

function closeManualModal() {
  if (!manualModal) return;
  manualModal.style.display = 'none';
  manualModal.setAttribute('aria-hidden', 'true');
}

function renderManualSearchResults() {
  const q = (manualSearch?.value || '').trim().toLowerCase();
  const list = state.songDatabase?.songs ?? [];
  const EXCLUDED = [674, 675, 676, 707, 708, 709];
  const filtered = list.filter((s) => !EXCLUDED.includes(s.id) && s.title && s.title.toLowerCase().includes(q)).slice(0, 50);
  if (!manualSearchResults) return;
  if (q.length < 1) {
    manualSearchResults.innerHTML = '<p class="manual-search-hint">曲名を入力して検索</p>';
    return;
  }
  manualSearchResults.innerHTML = filtered.length
    ? filtered.map((s) => `<button type="button" class="manual-song-option" data-id="${s.id}" data-title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</button>`).join('')
    : '<p class="manual-search-hint">該当なし</p>';
  manualSearchResults.querySelectorAll('.manual-song-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.manualSelectedSong = { id: parseInt(btn.dataset.id, 10), title: (btn.textContent || btn.dataset.title || '').trim() };
      if (manualSelectedTitle) manualSelectedTitle.textContent = state.manualSelectedSong.title;
      if (manualSelected) manualSelected.style.display = 'block';
      manualSearchResults.innerHTML = '';
    });
  });
}

async function submitManualEntry() {
  if (!manualError) return;
  manualError.textContent = '';
  if (!state.manualSelectedSong) {
    manualError.textContent = '曲を選択してください';
    return;
  }
  const g = parseInt(manualGreat?.value || '0', 10) || 0;
  const o = parseInt(manualGood?.value || '0', 10) || 0;
  const b = parseInt(manualBad?.value || '0', 10) || 0;
  const m = parseInt(manualMiss?.value || '0', 10) || 0;
  const difficulty = (manualDifficulty?.value || 'master').toLowerCase();

  // PERFECT はデータベースの総ノーツ数から自動計算
  let totalNoteCount = null;
  if (state.songDatabase?.songs?.length) {
    const song = state.songDatabase.songs.find((s) => s.id === state.manualSelectedSong.id);
    const diffInfo = song?.difficulties?.[difficulty] ?? song?.difficulties?.[difficulty.toLowerCase()];
    if (typeof diffInfo === 'number') totalNoteCount = diffInfo;
    else if (diffInfo && typeof diffInfo.totalNoteCount === 'number') totalNoteCount = diffInfo.totalNoteCount;
  }
  if (totalNoteCount == null) {
    manualError.textContent = 'この曲・難易度の総ノーツ数が不明です（songDatabase.json を確認してください）';
    return;
  }
  const sumOthers = g + o + b + m;
  const p = totalNoteCount - sumOthers;
  if (p < 0) {
    manualError.textContent = 'PERFECT が負になってしまいます（GREAT/GOOD/BAD/MISS を確認してください）';
    return;
  }
  const point = p * 3 + g * 2 + o * 1;

  if (state.token) {
    try {
      await apiCall('/api/records', {
        method: 'POST',
        body: JSON.stringify({
          song_id: state.manualSelectedSong.id,
          difficulty,
          perfect: p,
          great: g,
          good: o,
          bad: b,
          miss: m,
          point,
          taken_at: null,
        }),
      });
    } catch (e) {
      manualError.textContent = '記録の保存に失敗: ' + (e.message || e);
      return;
    }
  }

  closeManualModal();
  // return パラメータがあればマイページへ戻す
  try {
    const params = new URLSearchParams(window.location.search);
    const ret = params.get('return');
    if (ret) {
      window.location.href = ret;
      return;
    }
  } catch (_) {
    // ignore
  }
}

init();
