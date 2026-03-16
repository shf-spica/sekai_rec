/**
 * 画像OCRツール - app.js
 * サーバー (PaddleOCR) でOCR処理を実行する
 */

import { parseGameResult } from './ocr-postprocess.js';

// ========================================
// State
// ========================================
const state = {
  files: [],       // { id, file, dataUrl }[]
  isProcessing: false,
  results: [],
  /** { songs: [{ id, title, difficulties }] } または 従来の string[]（songs.json のみの場合） */
  songDatabase: null,
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
// OCR Server (PaddleOCR)
// ========================================

function updateModelStatus() {
  if (!modelStatus) return;
  modelStatus.innerHTML = `
    <span class="status-dot ready"></span>
    <span>サーバーOCR 準備完了 (PaddleOCR)</span>
  `;
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
  };
}

// ========================================
// OCR Processing
// ========================================

async function processImages() {
  if (state.files.length === 0 || state.isProcessing) return;

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
      const ocrResult = await ocrViaServer(entry.file);

      updateProgressItem(i, 'active', 80);

      // プロセカ特化の後処理
      let parsed = null;
      if (state.songDatabase && (state.songDatabase.songs?.length > 0 || (Array.isArray(state.songDatabase) && state.songDatabase.length > 0))) {
        parsed = parseGameResult(ocrResult, state.songDatabase);
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

  updateModelStatus();
  ocrBtn.disabled = false;
  ocrBtn.textContent = 'OCR実行';
}

init();
