/**
 * 記録一覧ページ: ログイン済みユーザーの記録を Lv. / 難易度でグループ表示
 */

const state = {
  token: localStorage.getItem('prsk_ocr_token') || null,
  user: null,
  songDatabase: null,
  records: [],
  pageUsername: null,
  canEdit: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const loginRequiredEl = $('#records-login-required');
const loadingEl = $('#records-loading');
const contentEl = $('#records-content');
const groupsEl = $('#records-groups');
const emptyEl = $('#records-empty');
const recordsCountEl = $('#records-count');

// Manual entry (mypage)
const manualEntryBtn = $('#manual-entry-link');
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

state.manualSelectedSong = null;

const ingestPanel = $('#ingest-panel');
const ingestIssueBtn = $('#ingest-issue-btn');
const ingestTokenList = $('#ingest-token-list');

const JACKET_BASE = 'https://storage.sekai.best/sekai-jp-assets/music/jacket/jacket_s_';
function jacketUrl(songId) {
  const id = String(Number(songId)).padStart(3, '0');
  return `${JACKET_BASE}${id}/jacket_s_${id}.webp`;
}
/** 画像表示用: サーバー経由プロキシ（ブロック対策）。grayscale=true でモノクロ（記録なし用） */
function jacketProxyUrl(songId, grayscale = false) {
  const id = String(Number(songId));
  const base = `/api/jacket/${encodeURIComponent(id)}`;
  return grayscale ? `${base}?gray=1` : base;
}
function getPlayLevel(song, difficulty) {
  if (!song?.difficulties) return 0;
  const d = song.difficulties[difficulty] ?? song.difficulties[difficulty?.toLowerCase()];
  if (d == null) return 0;
  return typeof d === 'object' && d.playLevel != null ? d.playLevel : 0;
}

function getSongById(songId) {
  const idNum = Number(songId);
  return (
    state.songDatabase?.songs?.find(
      (s) => String(s.id) === String(songId) || (Number.isFinite(idNum) && s.id === idNum),
    ) ?? null
  );
}

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

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function openManualModal() {
  if (!manualModal) return;
  state.manualSelectedSong = null;
  if (manualSearch) manualSearch.value = '';
  if (manualSelected) manualSelected.style.display = 'none';
  if (manualSearchResults) manualSearchResults.innerHTML = '';
  if (manualDifficulty) manualDifficulty.value = 'master';
  [manualGreat, manualGood, manualBad, manualMiss].forEach((el) => {
    if (el) el.value = '0';
  });
  if (manualError) manualError.textContent = '';
  manualModal.style.display = 'flex';
  manualModal.setAttribute('aria-hidden', 'false');
  if (manualSearch) manualSearch.focus();
}

/** 詳細モーダルから: 曲・難易度をプリセットして手動入力を開く */
function openManualModalPrefill(songId, difficulty) {
  if (!manualModal) return;
  const song = getSongById(songId);
  const idNum = Number(songId);
  state.manualSelectedSong = {
    id: idNum,
    title: song?.title || `ID:${songId}`,
  };
  if (manualSelectedTitle) manualSelectedTitle.textContent = state.manualSelectedSong.title;
  if (manualSelected) manualSelected.style.display = 'block';
  if (manualSearch) manualSearch.value = '';
  if (manualSearchResults) manualSearchResults.innerHTML = '';
  const d = (difficulty || 'master').toLowerCase();
  const allowed = ['expert', 'master', 'append'];
  if (manualDifficulty) manualDifficulty.value = allowed.includes(d) ? d : 'master';
  [manualGreat, manualGood, manualBad, manualMiss].forEach((el) => {
    if (el) el.value = '0';
  });
  if (manualError) manualError.textContent = '';
  manualModal.style.display = 'flex';
  manualModal.setAttribute('aria-hidden', 'false');
  if (manualGreat) manualGreat.focus();
}

function closeManualModal() {
  if (!manualModal) return;
  manualModal.style.display = 'none';
  manualModal.setAttribute('aria-hidden', 'true');
}

function renderManualSearchResults() {
  const q = (manualSearch?.value || '').trim().toLowerCase();
  const list = state.songDatabase?.songs ?? [];
  const filtered = list
    .filter((s) => !EXCLUDED_SONG_IDS.includes(s.id) && s.title && s.title.toLowerCase().includes(q))
    .slice(0, 50);
  if (!manualSearchResults) return;
  if (q.length < 1) {
    manualSearchResults.innerHTML = '<p class="manual-search-hint">曲名を入力して検索</p>';
    return;
  }
  manualSearchResults.innerHTML = filtered.length
    ? filtered
        .map(
          (s) =>
            `<button type="button" class="manual-song-option" data-id="${s.id}" data-title="${escapeHtml(
              s.title,
            )}">${escapeHtml(s.title)}</button>`,
        )
        .join('')
    : '<p class="manual-search-hint">該当なし</p>';
  manualSearchResults.querySelectorAll('.manual-song-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.manualSelectedSong = {
        id: parseInt(btn.dataset.id, 10),
        title: (btn.textContent || btn.dataset.title || '').trim(),
      };
      if (manualSelectedTitle) manualSelectedTitle.textContent = state.manualSelectedSong.title;
      if (manualSelected) manualSelected.style.display = 'block';
      manualSearchResults.innerHTML = '';
    });
  });
}

async function submitManualEntry() {
  if (!manualError) return;
  manualError.textContent = '';
  if (!state.canEdit) {
    manualError.textContent = '自分のページでのみ編集できます';
    return;
  }
  if (!state.manualSelectedSong) {
    manualError.textContent = '曲を選択してください';
    return;
  }
  const g = parseInt(manualGreat?.value || '0', 10) || 0;
  const o = parseInt(manualGood?.value || '0', 10) || 0;
  const b = parseInt(manualBad?.value || '0', 10) || 0;
  const m = parseInt(manualMiss?.value || '0', 10) || 0;
  const difficulty = (manualDifficulty?.value || 'master').toLowerCase();

  // PERFECT は総ノーツ数から自動計算
  let totalNoteCount = null;
  const song = state.songDatabase?.songs?.find((s) => s.id === state.manualSelectedSong.id);
  const diffInfo = song?.difficulties?.[difficulty] ?? song?.difficulties?.[difficulty.toLowerCase()];
  if (typeof diffInfo === 'number') totalNoteCount = diffInfo;
  else if (diffInfo && typeof diffInfo.totalNoteCount === 'number') totalNoteCount = diffInfo.totalNoteCount;

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

  // ローカル状態更新（該当カードだけ更新）
  const idx = state.records.findIndex(
    (r) => String(r.song_id) === String(state.manualSelectedSong.id) && (r.difficulty || '').toLowerCase() === difficulty,
  );
  const newRecord = {
    song_id: state.manualSelectedSong.id,
    difficulty,
    perfect: p,
    great: g,
    good: o,
    bad: b,
    miss: m,
    point,
    taken_at: null,
  };
  if (idx >= 0) state.records[idx] = { ...state.records[idx], ...newRecord };
  else state.records.push(newRecord);

  updateOneCard(state.manualSelectedSong.id, difficulty, newRecord);
  closeManualModal();
}

/** 期間限定など一覧に表示しない楽曲ID（ocr-postprocess.js の EXCLUDED_SONG_IDS と一致させる） */
const EXCLUDED_SONG_IDS = [674, 675, 676, 707, 708, 709];

function updateRecordsCount() {
  if (!recordsCountEl) return;
  const songs = (state.songDatabase?.songs ?? []).filter((s) => !EXCLUDED_SONG_IDS.includes(s.id));
  let total = 0;
  for (const song of songs) {
    if (!song?.difficulties || typeof song.difficulties !== 'object') continue;
    for (const diff of Object.keys(song.difficulties)) {
      if (DIFF_ORDER.includes(String(diff).toLowerCase())) total += 1;
    }
  }

  const unique = new Set();
  for (const r of state.records) {
    const d = String(r?.difficulty || '').toLowerCase();
    if (!DIFF_ORDER.includes(d)) continue;
    unique.add(`${r.song_id}-${d}`);
  }
  recordsCountEl.textContent = `記録数: ${unique.size}/${total}`;
}

/** 全曲×難易度のスロットを生成し、ユーザー記録をマージして playLevel → difficulty でグループ化 */
function buildSlotsByLevel() {
  const recordByKey = new Map();
  for (const r of state.records) {
    const key = `${r.song_id}-${(r.difficulty || '').toLowerCase()}`;
    recordByKey.set(key, r);
  }

  const byLevel = new Map();
  const songs = (state.songDatabase?.songs ?? []).filter((s) => !EXCLUDED_SONG_IDS.includes(s.id));
  for (const song of songs) {
    if (!song.difficulties || typeof song.difficulties !== 'object') continue;
    for (const diff of Object.keys(song.difficulties)) {
      const d = String(diff).toLowerCase();
      if (!DIFF_ORDER.includes(d)) continue;
      const playLevel = getPlayLevel(song, diff);
      const key = `${song.id}-${d}`;
      const record = recordByKey.get(key) || null;
      const slot = { songId: song.id, difficulty: d, song, playLevel, record };
      const level = playLevel || 0;
      if (!byLevel.has(level)) byLevel.set(level, new Map());
      const byDiff = byLevel.get(level);
      if (!byDiff.has(d)) byDiff.set(d, []);
      byDiff.get(d).push(slot);
    }
  }

  const levels = Array.from(byLevel.keys()).sort((a, b) => b - a);
  const result = [];
  for (const level of levels) {
    const byDiff = byLevel.get(level);
    const diffs = Array.from(byDiff.keys()).sort(diffOrder);
    result.push({
      playLevel: level,
      difficulties: diffs.map((d) => {
        const slots = [...byDiff.get(d)];
        slots.sort((a, b) => {
          const hasA = !!a.record;
          const hasB = !!b.record;
          if (hasA && !hasB) return -1;
          if (!hasA && hasB) return 1;
          if (!hasA && !hasB) return 0;
          const ra = a.record;
          const rb = b.record;
          const apA = isAllPerfect(ra);
          const apB = isAllPerfect(rb);
          if (apA && !apB) return -1;
          if (!apA && apB) return 1;
          const fcA = isFullCombo(ra);
          const fcB = isFullCombo(rb);
          if (fcA && !fcB) return -1;
          if (!fcA && fcB) return 1;
          const pmA = calcPointMinus(ra);
          const pmB = calcPointMinus(rb);
          return pmB - pmA;
        });
        return { difficulty: d, slots };
      }),
    });
  }
  return result;
}

// マイページ表示は MASTER→EXPERT→APPEND（EASY/NORMAL/HARD は除外）
const DIFF_ORDER = ['master', 'expert', 'append'];
function diffOrder(a, b) {
  const i = DIFF_ORDER.indexOf(a);
  const j = DIFF_ORDER.indexOf(b);
  if (i !== -1 && j !== -1) return i - j;
  if (i !== -1) return -1;
  if (j !== -1) return 1;
  return String(a).localeCompare(String(b));
}

function isAllPerfect(record) {
  if (!record) return false;
  return (record.miss || 0) + (record.bad || 0) + (record.good || 0) + (record.great || 0) === 0;
}
function isFullCombo(record) {
  if (!record) return false;
  return (record.miss || 0) + (record.bad || 0) + (record.good || 0) === 0;
}

function calcPointMinus(record) {
  if (!record) return 0;
  const g = record.great || 0;
  const good = record.good || 0;
  const b = record.bad || 0;
  const m = record.miss || 0;
  return -1 * (g + good * 2 + b * 3 + m * 3);
}

function renderGroups() {
  updateRecordsCount();
  const groups = buildSlotsByLevel();
  if (groups.length === 0) {
    contentEl.style.display = 'none';
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';
  contentEl.style.display = 'block';

  const levelStats = (g) => {
    const stats = {
      main: { total: 0, ap: 0, fc: 0 },
      append: { total: 0, ap: 0, fc: 0 },
    };
    for (const df of g.difficulties) {
      const isAppend = String(df.difficulty).toLowerCase() === 'append';
      const bucket = isAppend ? stats.append : stats.main;
      for (const slot of df.slots) {
        bucket.total += 1;
        if (slot.record) {
          if (isAllPerfect(slot.record)) bucket.ap += 1;
          if (isFullCombo(slot.record)) bucket.fc += 1;
        }
      }
    }
    return stats;
  };

  groupsEl.innerHTML = groups
    .map((g) => {
      const st = levelStats(g);
      const mainText = `AP ${st.main.ap}/${st.main.total} · FC ${st.main.fc}/${st.main.total}`;
      const appendText = `APPEND AP ${st.append.ap}/${st.append.total} · FC ${st.append.fc}/${st.append.total}`;
      return `
    <section class="records-level-section" data-level="${g.playLevel}">
      <h2 class="records-level-title">
        <span>Lv.${g.playLevel}</span>
        <span class="records-level-stats">
          <span class="records-level-stat records-level-stat-main">${escapeHtml(mainText)}</span>
          <span class="records-level-stat records-level-stat-append">${escapeHtml(appendText)}</span>
        </span>
      </h2>
      ${g.difficulties
        .map(
          (df) => `
        <div class="records-diff-block">
          <h3 class="records-diff-title">${escapeHtml(df.difficulty.toUpperCase())}</h3>
          <div class="records-grid">
            ${df.slots
              .map((slot) => {
                const r = slot.record;
                const hasRecord = !!r;
                const ap = hasRecord && isAllPerfect(r);
                const fc = hasRecord && !ap && isFullCombo(r);
                const cardClasses = ['record-card'];
                if (!hasRecord) cardClasses.push('record-card-no-record');
                if (ap) cardClasses.push('record-card-ap');
                if (fc) cardClasses.push('record-card-fc');
                const dataAttrs = hasRecord
                  ? `data-perfect="${r.perfect}" data-great="${r.great}" data-good="${r.good}" data-bad="${r.bad}" data-miss="${r.miss}" data-point="${r.point}" data-taken-at="${r.taken_at || ''}"`
                  : '';
                const imgUrl = jacketProxyUrl(slot.songId, !hasRecord);
                const pm = hasRecord ? calcPointMinus(r) : 0;
                const titleText = slot.song?.title || `ID:${slot.songId}`;
                return `
              <button type="button" class="${cardClasses.join(' ')}" data-song-id="${slot.songId}" data-difficulty="${escapeHtml(slot.difficulty)}" data-has-record="${hasRecord}" ${dataAttrs}>
                <img class="record-card-jacket" src="${imgUrl}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.src=''; this.style.background='var(--bg-card)'">
                ${hasRecord ? `<span class="record-card-point-minus-badge">${pm}</span>` : ''}
                <span class="record-card-title">${escapeHtml(titleText)}</span>
              </button>
            `;
              })
              .join('')}
          </div>
        </div>
      `
        )
        .join('')}
    </section>
  `;
    })
    .join('');

  groupsEl.querySelectorAll('.record-card').forEach((btn) => {
    btn.addEventListener('click', () => openDetail(btn));
  });
}

/**
 * 指定した曲・難易度のカード1枚だけを更新する（renderGroups を呼ばない）
 * @param {string|number} songId
 * @param {string} difficulty - 小文字の難易度
 * @param {object|null} record - 記録オブジェクト（削除時は null）
 */
function updateOneCard(songId, difficulty, record) {
  const card = groupsEl.querySelector(
    `.record-card[data-song-id="${songId}"][data-difficulty="${difficulty}"]`
  );
  if (!card) return;
  const hasRecord = record != null;
  card.dataset.hasRecord = String(hasRecord);
  if (hasRecord) {
    card.dataset.perfect = String(record.perfect);
    card.dataset.great = String(record.great);
    card.dataset.good = String(record.good);
    card.dataset.bad = String(record.bad);
    card.dataset.miss = String(record.miss);
    card.dataset.point = String(record.point);
    card.dataset.takenAt = record.taken_at || '';
    card.classList.remove('record-card-no-record', 'record-card-ap', 'record-card-fc');
    if (isAllPerfect(record)) {
      card.classList.add('record-card-ap');
    } else if (isFullCombo(record)) {
      card.classList.add('record-card-fc');
    }
    const img = card.querySelector('.record-card-jacket');
    if (img) img.src = jacketProxyUrl(songId, false);
    let badge = card.querySelector('.record-card-point-minus-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'record-card-point-minus-badge';
      const titleSpan = card.querySelector('.record-card-title');
      card.insertBefore(badge, titleSpan);
    }
    badge.textContent = String(calcPointMinus(record));
    badge.hidden = false;
  } else {
    delete card.dataset.perfect;
    delete card.dataset.great;
    delete card.dataset.good;
    delete card.dataset.bad;
    delete card.dataset.miss;
    delete card.dataset.point;
    delete card.dataset.takenAt;
    card.classList.add('record-card-no-record');
    card.classList.remove('record-card-ap', 'record-card-fc');
    const img = card.querySelector('.record-card-jacket');
    if (img) img.src = jacketProxyUrl(songId, true);
    const badge = card.querySelector('.record-card-point-minus-badge');
    if (badge) badge.hidden = true;
  }
  updateRecordsCount();
}

function openDetail(btn) {
  const songId = btn.dataset.songId;
  const difficulty = btn.dataset.difficulty;
  const hasRecord = btn.dataset.hasRecord === 'true';
  const recordData = hasRecord
    ? {
        perfect: parseInt(btn.dataset.perfect, 10) || 0,
        great: parseInt(btn.dataset.great, 10) || 0,
        good: parseInt(btn.dataset.good, 10) || 0,
        bad: parseInt(btn.dataset.bad, 10) || 0,
        miss: parseInt(btn.dataset.miss, 10) || 0,
        point: parseInt(btn.dataset.point, 10) || 0,
      }
    : null;
  const song = getSongById(songId);
  const title = song?.title || `ID:${songId}`;

  const modal = $('#record-detail-modal');
  const jacketEl = $('#record-detail-jacket');
  const titleEl = $('#record-detail-title');
  const metaEl = $('#record-detail-meta');
  const pointEl = $('#record-detail-point');
  const judgmentsEl = $('#record-detail-judgments');
  const deleteBtn = $('#record-detail-delete');
  const addManualBtn = $('#record-detail-add-manual');
  const timeEl = $('#record-detail-time');

  jacketEl.src = jacketProxyUrl(songId);
  jacketEl.alt = title;
  titleEl.textContent = title;
  const takenAt = btn.dataset.takenAt || '';
  const timeText = takenAt ? new Date(takenAt).toLocaleString() : '-';
  metaEl.textContent = `Lv.${getPlayLevel(song, difficulty)} · ${(difficulty || '').toUpperCase()}`;
  if (timeEl) timeEl.textContent = timeText ? `記録日時: ${timeText}` : '';

  const diffNorm = (difficulty || '').toLowerCase();

  if (!hasRecord || !recordData) {
    pointEl.textContent = '';
    pointEl.parentElement.classList.add('record-detail-no-record');
    judgmentsEl.innerHTML = '<p class="record-detail-empty">記録がありません</p>';
    if (deleteBtn) {
      deleteBtn.style.display = 'none';
      deleteBtn.onclick = null;
    }
  } else {
    pointEl.parentElement.classList.remove('record-detail-no-record');
    pointEl.textContent = `Point: ${recordData.point.toLocaleString()}`;
    judgmentsEl.innerHTML = ['PERFECT', 'GREAT', 'GOOD', 'BAD', 'MISS']
      .map(
        (j) => `
      <div class="judgment-item">
        <span class="judgment-label ${j.toLowerCase()}">${j}</span>
        <span class="judgment-value">${recordData[j.toLowerCase()] ?? 0}</span>
      </div>
    `
      )
      .join('');
    if (deleteBtn) {
      deleteBtn.style.display = state.canEdit ? '' : 'none';
      deleteBtn.onclick = !state.canEdit
        ? null
        : async () => {
        if (!confirm('この記録を削除しますか？')) return;
        try {
          await apiCall(
            `/api/records?song_id=${encodeURIComponent(songId)}&difficulty=${encodeURIComponent(difficulty)}`,
            { method: 'DELETE' },
          );
          state.records = state.records.filter(
            (r) =>
              !(
                String(r.song_id) === String(songId) &&
                (r.difficulty || '').toLowerCase() === (difficulty || '').toLowerCase()
              ),
          );
          closeDetail();
          // 押したカードだけ「記録なし」に更新
          updateOneCard(songId, diffNorm, null);
        } catch (e) {
          console.error(e);
        }
      };
    }
  }

  if (addManualBtn) {
    if (!state.canEdit || !state.token) {
      addManualBtn.style.display = 'none';
      addManualBtn.onclick = null;
    } else {
      addManualBtn.style.display = '';
      addManualBtn.onclick = () => {
        closeDetail();
        openManualModalPrefill(songId, diffNorm);
      };
    }
  }

  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
}

function closeDetail() {
  const modal = $('#record-detail-modal');
  if (modal) {
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }
}

function openIngestReveal(secret) {
  const wrap = document.getElementById('ingest-token-reveal');
  const input = document.getElementById('ingest-token-reveal-input');
  if (!wrap || !input) return;
  input.value = secret;
  wrap.style.display = 'flex';
  wrap.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function closeIngestReveal() {
  const wrap = document.getElementById('ingest-token-reveal');
  const input = document.getElementById('ingest-token-reveal-input');
  if (wrap) {
    wrap.style.display = 'none';
    wrap.setAttribute('aria-hidden', 'true');
  }
  if (input) input.value = '';
}

function formatIngestCreatedAt(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

async function loadIngestTokens() {
  if (!ingestTokenList || !state.canEdit || !state.token) return;
  try {
    const data = await apiCall('/api/ingest-tokens');
    const items = data.tokens || [];
    ingestTokenList.innerHTML = items.length
      ? items
          .map(
            (t) => `
        <li class="ingest-token-item">
          <span class="ingest-token-meta">${escapeHtml(formatIngestCreatedAt(t.created_at))}</span>
          <button type="button" class="btn btn-ghost btn-sm ingest-token-revoke" data-id="${t.id}">削除</button>
        </li>`,
          )
          .join('')
      : '<li class="ingest-token-empty">—</li>';
    ingestTokenList.querySelectorAll('.ingest-token-revoke').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (!id || !confirm('このトークンを削除しますか？（ショートカットからの取り込みができなくなります）')) return;
        try {
          await apiCall(`/api/ingest-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
          await loadIngestTokens();
        } catch (e) {
          console.error(e);
          alert(e.message || '削除に失敗しました');
        }
      });
    });
  } catch (e) {
    console.error(e);
    ingestTokenList.innerHTML = '<li class="ingest-token-empty">一覧の取得に失敗しました。</li>';
  }
}

async function issueIngestToken() {
  if (!state.canEdit || !state.token) return;
  try {
    const data = await apiCall('/api/ingest-tokens', {
      method: 'POST',
      body: '{}',
    });
    const secret = data?.ingest_secret ?? data?.token;
    if (!secret) {
      alert('トークンを受け取れませんでした。サーバーまたは通信経路の設定を確認してください。');
      await loadIngestTokens();
      return;
    }
    openIngestReveal(secret);
    try {
      await navigator.clipboard.writeText(secret);
    } catch {
      /* 自動コピー不可環境ではモーダルから手動コピー */
    }
    await loadIngestTokens();
  } catch (e) {
    alert(e.message || '発行に失敗しました');
  }
}

async function init() {
  try {
    // /records/{username} から username を取得
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts[0] === 'records' && parts[1]) {
      const candidate = decodeURIComponent(parts[1]);
      // /records/index.html のような誤ったパスを username と誤認しない
      if (!/\.html$/i.test(candidate)) {
        state.pageUsername = candidate;
      }
    }

    const dbRes = await fetch('/songDatabase.json');
    if (dbRes.ok) state.songDatabase = await dbRes.json();

    // ログインしていれば me を取得（編集可否の判定に使う）
    if (state.token) {
      const meRes = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${state.token}` } });
      const meData = meRes.ok ? await meRes.json().catch(() => ({})) : null;
      if (meData?.user) {
        state.user = meData.user;
      } else {
        state.token = null;
        localStorage.removeItem('prsk_ocr_token');
      }
    }

    // 公開APIからレコード取得（閲覧は誰でも）
    if (!state.pageUsername) {
      // username が取れない場合は自分のページへ誘導
      if (state.user?.username) {
        window.location.href = `/records/${encodeURIComponent(state.user.username)}`;
        return;
      }
      // 未ログインで /records/{username} 以外に来た場合はここで止める
      loadingEl.style.display = 'none';
      loginRequiredEl.style.display = 'block';
      contentEl.style.display = 'none';
      emptyEl.style.display = 'none';
      return;
    }
    const publicRes = await fetch(`/api/public/records?username=${encodeURIComponent(state.pageUsername)}`);
    if (!publicRes.ok) {
      const d = await publicRes.json().catch(() => ({}));
      throw new Error(d?.detail || publicRes.statusText || 'Request failed');
    }
    const publicData = await publicRes.json();
    state.records = publicData.records || [];

    state.canEdit = !!(state.user?.username && state.user.username === state.pageUsername);

    const authUser = $('#auth-user');
    if (authUser) {
      authUser.textContent = state.pageUsername || '';
    }

    if (manualEntryBtn) {
      manualEntryBtn.style.display = state.canEdit ? '' : 'none';
    }

    if (ingestPanel) {
      if (state.canEdit && state.token) {
        ingestPanel.style.display = 'block';
        await loadIngestTokens();
      } else {
        ingestPanel.style.display = 'none';
      }
    }

    const logoutBtn = $('#auth-logout-btn');
    if (logoutBtn) {
      if (state.user) {
        logoutBtn.style.display = '';
        logoutBtn.addEventListener('click', () => {
          state.token = null;
          state.user = null;
          localStorage.removeItem('prsk_ocr_token');
          window.location.href = 'index.html';
        });
      } else {
        logoutBtn.style.display = 'none';
      }
    }

    // 他人のページ閲覧時の「公開されています」案内は表示しない
    loginRequiredEl.style.display = 'none';
  } catch (e) {
    console.error(e);
    loadingEl.innerHTML = '<p>読み込みに失敗しました。</p>';
    return;
  }

  loadingEl.style.display = 'none';
  renderGroups();

  if (manualEntryBtn) manualEntryBtn.addEventListener('click', openManualModal);
  if (manualModalBackdrop) manualModalBackdrop.addEventListener('click', closeManualModal);
  if (manualModalCancel) manualModalCancel.addEventListener('click', closeManualModal);
  if (manualSearch) manualSearch.addEventListener('input', renderManualSearchResults);
  if (manualSubmit) manualSubmit.addEventListener('click', submitManualEntry);

  $('#record-detail-backdrop')?.addEventListener('click', closeDetail);
  $('#record-detail-close')?.addEventListener('click', closeDetail);

  if (ingestIssueBtn) ingestIssueBtn.addEventListener('click', issueIngestToken);
  const ingestRevealBackdrop = document.getElementById('ingest-token-reveal-backdrop');
  const ingestRevealClose = document.getElementById('ingest-token-reveal-close');
  const ingestCopyBtn = document.getElementById('ingest-token-copy-btn');
  if (ingestRevealBackdrop) ingestRevealBackdrop.addEventListener('click', closeIngestReveal);
  if (ingestRevealClose) ingestRevealClose.addEventListener('click', closeIngestReveal);
  if (ingestCopyBtn) {
    ingestCopyBtn.addEventListener('click', () => {
      const input = document.getElementById('ingest-token-reveal-input');
      if (!input) return;
      input.select();
      navigator.clipboard.writeText(input.value).then(
        () => {
          ingestCopyBtn.textContent = 'コピーしました';
          setTimeout(() => {
            ingestCopyBtn.textContent = 'コピー';
          }, 1500);
        },
        () => {},
      );
    });
  }
}

init();
