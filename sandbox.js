
let consoleLogs = [];
const console = { log: (...args) => consoleLogs.push("LOG: " + args.join(' ')), warn: (...args) => consoleLogs.push("WARN: " + args.join(' ')), error: (...args) => consoleLogs.push("ERR: " + args.join(' ')) };

const document = {
  querySelector: (sel) => ({
    style: {},
    innerHTML: '',
    className: '',
    checked: true,
    addEventListener: () => {},
    dataset: {},
    textContent: ''
  }),
  querySelectorAll: () => []
};

const window = { Tesseract: { createWorker: async () => ({ loadLanguage: async()=>{}, initialize: async()=>{}, recognize: async() => ({data:{text:'a'}}), terminate: async()=>{} }) } };
const performance = { now: () => 0 };
const navigator = { clipboard: { writeText: async() => {} } };

class FileReader {
  readAsDataURL() { this.onload({target:{result:'data:image/empty'}}); }
}

/**
 * 画像OCRツール - app.js
 * 複数画像のOCR処理をtesseract.jsで実行する
 * 
 * サーバーサイド移行時は processImages() 内の ocrSingleImage() を
 * API呼び出しに置き換えるだけで対応可能
 */

// ========================================
// State
// ========================================
const state = {
  files: [],       // { id, file, dataUrl }[]
  isProcessing: false,
  results: [],     // Add this
  songList: [],    // loaded from songs.json
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
  state.results = []; // Clear results as well
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
      <button class="remove-btn" onclick="removeFile(${entry.id})" title="削除">✕</button>
      <div class="file-name">${entry.file.name}</div>
    </div>
  `).join('');
}

// ========================================
// OCR Processing
// ========================================

/**
 * 選択された言語を取得
 */
function getSelectedLanguages() {
  const langs = [];
  if ($('#lang-jpn').checked) langs.push('jpn');
  if ($('#lang-eng').checked) langs.push('eng');
  return langs.length > 0 ? langs.join('+') : 'eng';
}

/**
 * Tesseract.jsを使って画像を解析し、生データ（行情報含む）を返す
 * @param {File} file 
 * @param {string} langs (ex: "jpn+eng")
 * @returns {Promise<Object>} Tesseractの解析結果オブジェクト
 */
async function ocrSingleImageFull(file, langs, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const worker = await Tesseract.createWorker({
          logger: m => {
            if (m.status === 'recognizing text' && typeof m.progress === 'number') {
              onProgress(Math.round(m.progress * 100));
            }
          }
        });
        await worker.loadLanguage(langs);
        await worker.initialize(langs);
        const result = await worker.recognize(e.target.result);
        await worker.terminate();
        resolve(result);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * 複数画像のOCR処理を実行
 */
async function processImages() {
  if (state.files.length === 0 || state.isProcessing) return;

  state.isProcessing = true;
  ocrBtn.disabled = true;

  const langStr = getSelectedLanguages();

  // Show progress UI
  resultsSection.style.display = '';
  resultsList.innerHTML = renderProgressUI(state.files);

  state.results = []; // Clear previous results

  for (let i = 0; i < state.files.length; i++) {
    const entry = state.files[i];
    const startTime = performance.now();

    // Update progress state
    updateProgressItem(i, 'active', 0);

    try {
      const tesseractResult = await ocrSingleImageFull(entry.file, langStr, (progress) => {
        updateProgressItem(i, 'active', progress);
      });

      // プロセカ特化の後処理（ocr-postprocess.js）
      let parsed = null;
      if (window.parseGameResult && state.songList.length > 0) {
        parsed = window.parseGameResult(tesseractResult, state.songList);
      }

      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

      state.results.push({
        entry,
        rawText: tesseractResult.data.text,
        parsed: parsed,
        elapsed,
        error: null
      });
      updateProgressItem(i, 'done', 100);
    } catch (err) {
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      state.results.push({ entry, parsed: null, rawText: '', elapsed, error: err.message });
      updateProgressItem(i, 'done', 100);
    }
  }

  // Render final results
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
    let rawText = r.rawText || ''; // Changed from r.text to r.rawText
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

      copyText = `曲名: ${songTitle}\\n`;
      copyText += ['PERFECT', 'GREAT', 'GOOD', 'BAD', 'MISS'].map(j => `${j}: ${judgments[j]}`).join('\\n');
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
            <button class="btn btn-ghost btn-sm" onclick="toggleRawText(${i})" id="raw-toggle-btn-${i}">生テキストを表示</button>
          </div>
          <div class="result-text raw-text-container" id="result-text-${i}" style="display: none;" data-copy="${escapeHtml(copyText)}">${escapeHtml(rawText || 'テキストが検出されませんでした')}</div>
        </div>
        <div class="result-actions">
          <span class="copy-feedback" id="copy-feedback-${i}">コピーしました</span>
          <button class="btn btn-ghost" onclick="copyResult(${i})">
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

window.toggleRawText = function (index) {
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

function copyResult(index) {
  const textEl = $(`#result-text-${index}`);
  if (!textEl) return;

  const copyText = textEl.dataset.copy || textEl.textContent;

  navigator.clipboard.writeText(copyText).then(() => {
    showCopyFeedback(index);
  }).catch(() => {
    // Fallback
    const range = document.createRange();
    range.selectNodeContents(textEl);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.execCommand('copy');
    window.getSelection().removeAllRanges();
    showCopyFeedback(index);
  });
}

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
/**
 * 初期化処理
 */
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

  // Tesseract script tag is loaded synchronously/asynchronously via CDN.
  // Ensure the button is enabled when the script completes loading.
  if (window.Tesseract) {
    ocrBtn.disabled = false;
    ocrBtn.textContent = "OCR実行";
  } else {
    // If the script loads slowly, wait for it
    ocrBtn.disabled = true;
    ocrBtn.textContent = "エンジン読込中...";
    let retries = 0;
    const waitTesseract = setInterval(() => {
      if (window.Tesseract) {
        clearInterval(waitTesseract);
        ocrBtn.disabled = false;
        ocrBtn.textContent = "OCR実行";
      } else if (retries++ > 40) { // 10 seconds max
        clearInterval(waitTesseract);
        ocrBtn.textContent = "エンジン読込失敗";
      }
    }, 250);
  }
}

// 起動時にリソースを読み込む
init();


state.files.push({ id: 1, file: { name: 'test.jpg' }, dataUrl: 'data' });

(async () => {
  consoleLogs.push("--- Before processImages ---");
  try {
    await processImages();
    consoleLogs.push("--- After processImages ---");
    consoleLogs.push("state.isProcessing: " + state.isProcessing);
    consoleLogs.push("state.results length: " + state.results.length);
  } catch (e) {
    consoleLogs.push("UNCAUGHT EXCEPTION: " + e.stack);
  }
  require('fs').writeFileSync('debug_output.txt', consoleLogs.join('\n'));
})();
