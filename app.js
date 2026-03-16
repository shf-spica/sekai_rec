/**
 * 画像OCRツール - app.js
 * ndlocr-lite (WASM) でOCR処理を実行する
 */

import { parseGameResult } from './ocr-postprocess.js';

// ========================================
// State
// ========================================
const state = {
  files: [],       // { id, file, dataUrl }[]
  isProcessing: false,
  results: [],
  songList: [],
  modelReady: false,
};

let fileIdCounter = 0;
let ocrWorker = null;
let pendingOCR = new Map(); // id → { resolve, reject }
let ocrIdCounter = 0;

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
const modelStatus = $('#model-status');

// ========================================
// File Handling
// ========================================

function handleFiles(fileList) {
  const imageFiles = Array.from(fileList).filter(f => f.type.startsWith('image/'));
  if (imageFiles.length === 0) return;

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
    };
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
// Drag & Drop
// ========================================

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

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
  langSection.style.display = hasFiles ? '' : 'none';

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
// Image → ImageData conversion
// ========================================

function fileToImageData(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(imageData);
    };
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject(new Error('画像の読み込みに失敗しました'));
    };
    img.src = URL.createObjectURL(file);
  });
}

// ========================================
// OCR Worker Communication
// ========================================

function initWorker() {
  ocrWorker = new Worker(
    new URL('./ocr-worker.js', import.meta.url),
    { type: 'module' }
  );

  ocrWorker.addEventListener('message', (e) => {
    const msg = e.data;

    switch (msg.type) {
      case 'OCR_PROGRESS':
        if (msg.id) {
          // OCR処理中の進捗（特定ファイル）
          // 現在は進捗バーで対応済み
        } else {
          // モデル初期化の進捗
          updateModelStatus(msg);
        }
        break;

      case 'OCR_COMPLETE': {
        state.modelReady = true;
        const pending = pendingOCR.get(msg.id);
        if (pending) {
          pending.resolve({
            textBlocks: msg.textBlocks,
            fullText: msg.txt,
            processingTime: msg.processingTime,
          });
          pendingOCR.delete(msg.id);
        }
        break;
      }

      case 'OCR_ERROR': {
        if (msg.stage === 'initialization') {
          // 初期化エラー
          ocrBtn.disabled = true;
          ocrBtn.textContent = '初期化失敗';
          if (modelStatus) {
            modelStatus.innerHTML = `
              <span class="status-dot error"></span>
              <span>エラー: ${msg.error}</span>
            `;
          }
        } else if (msg.id) {
          // OCR処理エラー
          const pending = pendingOCR.get(msg.id);
          if (pending) {
            pending.reject(new Error(msg.error));
            pendingOCR.delete(msg.id);
          }
        }
        break;
      }
    }
  });

  ocrWorker.postMessage({ type: 'INITIALIZE' });
}

function updateModelStatus(msg) {
  if (!modelStatus) return;

  if (msg.stage === 'initialized') {
    // モデル初期化完了
    state.modelReady = true;
    ocrBtn.disabled = false;
    ocrBtn.textContent = 'OCR実行';
    modelStatus.innerHTML = `
      <span class="status-dot ready"></span>
      <span>ndlocr-lite 準備完了 (WASM)</span>
    `;
    return;
  }

  const pct = Math.round(msg.progress * 100);
  if (msg.stage === 'loading_models') {
    modelStatus.innerHTML = `
      <span class="status-dot loading"></span>
      <span>${msg.message}</span>
      <div class="model-progress-bar">
        <div class="model-progress-fill" style="width: ${pct}%"></div>
      </div>
      <span class="model-progress-text">${pct}%</span>
    `;
  } else {
    modelStatus.innerHTML = `
      <span class="status-dot loading"></span>
      <span>${msg.message || 'モデル読込中...'}</span>
    `;
  }
}

/**
 * Worker経由でOCR実行
 * @param {File} file
 * @returns {Promise<Object>} ndlocr-liteの結果 { textBlocks, fullText, processingTime }
 */
async function ocrViaWorker(file) {
  // FileをImageDataに変換してWorkerに送信
  const imageData = await fileToImageData(file);

  return new Promise((resolve, reject) => {
    const id = String(++ocrIdCounter);
    pendingOCR.set(id, { resolve, reject });

    ocrWorker.postMessage({
      type: 'OCR_PROCESS',
      id,
      imageData,
      startTime: Date.now(),
    });
  });
}

// ========================================
// OCR Processing
// ========================================

async function processImages() {
  if (state.files.length === 0 || state.isProcessing || !state.modelReady) return;

  state.isProcessing = true;
  ocrBtn.disabled = true;

  // Show progress UI
  resultsSection.style.display = '';
  resultsList.innerHTML = renderProgressUI(state.files);

  state.results = [];

  for (let i = 0; i < state.files.length; i++) {
    const entry = state.files[i];
    const startTime = performance.now();

    updateProgressItem(i, 'active', 30);

    try {
      const ocrResult = await ocrViaWorker(entry.file);

      updateProgressItem(i, 'active', 80);

      // プロセカ特化の後処理
      let parsed = null;
      if (state.songList.length > 0) {
        parsed = parseGameResult(ocrResult, state.songList);
      }

      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

      state.results.push({
        entry,
        rawText: ocrResult.fullText || '',
        parsed: parsed,
        elapsed,
        error: null,
      });
      updateProgressItem(i, 'done', 100);
    } catch (err) {
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      state.results.push({ entry, parsed: null, rawText: '', elapsed, error: err.message });
      updateProgressItem(i, 'done', 100);
    }
  }

  renderResults(state.results);

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
  resultsList.innerHTML = results.map((r, i) => {
    let parsedHtml = '';
    let rawText = r.rawText || '';
    let copyText = rawText;

    if (r.parsed) {
      const { songTitle, matchConfidence, judgments, rawText: rt } = r.parsed;
      rawText = rt;

      const confClass = matchConfidence >= 0.8 ? 'conf-high' : (matchConfidence >= 0.4 ? 'conf-med' : 'conf-low');

      const judgmentHtml = ['PERFECT', 'GREAT', 'GOOD', 'BAD', 'MISS'].map(j => `
        <div class="judgment-item">
          <span class="judgment-label ${j.toLowerCase()}">${j}</span>
          <span class="judgment-value">${judgments[j]}</span>
        </div>
      `).join('');

      parsedHtml = `
        <div class="parsed-result">
          <div class="song-match">
            <span class="match-label">推測される楽曲名:</span>
            <span class="match-title">${escapeHtml(songTitle)}</span>
            <span class="match-conf ${confClass}">信頼度: ${Math.round(matchConfidence * 100)}%</span>
          </div>
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
// Initialization
// ========================================

async function init() {
  console.log("Loading songs.json...");

  try {
    const res = await fetch('songs.json');
    if (res.ok) {
      state.songList = await res.json();
      console.log(`Loaded ${state.songList.length} songs.`);
    } else {
      console.warn("Failed to load songs.json", res.status);
    }
  } catch (e) {
    console.error("Error loading songs.json", e);
  }

  // ndlocr-lite Worker を起動
  ocrBtn.disabled = true;
  ocrBtn.textContent = 'モデル読込中...';
  initWorker();
}

init();
