/**
 * 記録一覧ページ: ログイン済みユーザーの記録を Lv. / 難易度でグループ表示
 */

const state = {
  token: localStorage.getItem('prsk_ocr_token') || null,
  user: null,
  songDatabase: null,
  records: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const loginRequiredEl = $('#records-login-required');
const loadingEl = $('#records-loading');
const contentEl = $('#records-content');
const groupsEl = $('#records-groups');
const emptyEl = $('#records-empty');

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
  return state.songDatabase?.songs?.find((s) => s.id === songId) ?? null;
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

/** 期間限定など一覧に表示しない楽曲ID（ocr-postprocess.js の EXCLUDED_SONG_IDS と一致させる） */
const EXCLUDED_SONG_IDS = [674, 675, 676, 707, 708, 709];

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
      const playLevel = getPlayLevel(song, diff);
      const key = `${song.id}-${diff}`;
      const record = recordByKey.get(key) || null;
      const slot = { songId: song.id, difficulty: diff, song, playLevel, record };
      const level = playLevel || 0;
      if (!byLevel.has(level)) byLevel.set(level, new Map());
      const byDiff = byLevel.get(level);
      if (!byDiff.has(diff)) byDiff.set(diff, []);
      byDiff.get(diff).push(slot);
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

const DIFF_ORDER = ['easy', 'normal', 'hard', 'expert', 'master', 'append'];
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
  const groups = buildSlotsByLevel();
  if (groups.length === 0) {
    contentEl.style.display = 'none';
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';
  contentEl.style.display = 'block';

  groupsEl.innerHTML = groups
    .map(
      (g) => `
    <section class="records-level-section" data-level="${g.playLevel}">
      <h2 class="records-level-title">Lv.${g.playLevel}</h2>
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
                return `
              <button type="button" class="${cardClasses.join(' ')}" data-song-id="${slot.songId}" data-difficulty="${escapeHtml(slot.difficulty)}" data-has-record="${hasRecord}" ${dataAttrs}>
                <img class="record-card-jacket" src="${imgUrl}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.src=''; this.style.background='var(--bg-card)'">
                ${hasRecord ? `<span class="record-card-point-minus-badge">${pm}</span>` : ''}
                <span class="record-card-title">${escapeHtml(slot.song?.title || `ID:${slot.songId}`)}</span>
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
  `
    )
    .join('');

  groupsEl.querySelectorAll('.record-card').forEach((btn) => {
    btn.addEventListener('click', () => openDetail(btn));
  });
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
  const apBtn = $('#record-detail-ap');
  const timeEl = $('#record-detail-time');

  jacketEl.src = jacketProxyUrl(songId);
  jacketEl.alt = title;
  titleEl.textContent = title;
  const takenAt = btn.dataset.takenAt || '';
  const timeText = takenAt ? new Date(takenAt).toLocaleString() : '-';
  metaEl.textContent = `Lv.${getPlayLevel(song, difficulty)} · ${(difficulty || '').toUpperCase()}`;
  if (timeEl) timeEl.textContent = timeText ? `記録日時: ${timeText}` : '';

  if (!hasRecord || !recordData) {
    pointEl.textContent = '';
    pointEl.parentElement.classList.add('record-detail-no-record');
    judgmentsEl.innerHTML = '<p class="record-detail-empty">記録がありません</p>';
    if (deleteBtn) deleteBtn.style.display = 'none';
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
      deleteBtn.style.display = '';
      deleteBtn.onclick = async () => {
        if (!confirm('この記録を削除しますか？')) return;
        try {
          await apiCall(`/api/records?song_id=${encodeURIComponent(songId)}&difficulty=${encodeURIComponent(difficulty)}`, {
            method: 'DELETE',
          });
          state.records = state.records.filter(
            (r) => !(String(r.song_id) === String(songId) && (r.difficulty || '').toLowerCase() === (difficulty || '').toLowerCase()),
          );
          renderGroups();
          closeDetail();
        } catch (e) {
          console.error(e);
          alert('削除に失敗しました: ' + (e.message || e));
        }
      };
    }
  }

  // 「APとして記録」ボタンの制御
  if (apBtn) {
    apBtn.style.display = 'none';
    apBtn.onclick = null;
    const diffNorm = (difficulty || '').toLowerCase();
    const alreadyAp =
      hasRecord &&
      (recordData.bad || 0) === 0 &&
      (recordData.good || 0) === 0 &&
      (recordData.great || 0) === 0 &&
      (recordData.miss || 0) === 0;

    // ログインしていない / 曲データがない / すでにAPならボタン非表示
    if (!state.token || !song || alreadyAp) {
      // 何もしない
    } else {
      const diffInfo =
        song.difficulties?.[diffNorm] ??
        song.difficulties?.[difficulty] ??
        song.difficulties?.[difficulty?.toLowerCase()];
      let totalNoteCount = null;
      if (typeof diffInfo === 'number') totalNoteCount = diffInfo;
      else if (diffInfo && typeof diffInfo.totalNoteCount === 'number') totalNoteCount = diffInfo.totalNoteCount;

      if (totalNoteCount != null) {
        apBtn.style.display = '';
        apBtn.onclick = async () => {
          if (!confirm('この譜面を ALL PERFECT として記録しますか？')) return;
          const perfect = totalNoteCount;
          const great = 0;
          const good = 0;
          const bad = 0;
          const miss = 0;
          const point = perfect * 3;
          try {
            await apiCall('/api/records', {
              method: 'POST',
              body: JSON.stringify({
                song_id: Number(songId),
                difficulty: diffNorm,
                perfect,
                great,
                good,
                bad,
                miss,
                point,
                taken_at: null,
              }),
            });

            const idx = state.records.findIndex(
              (r) => String(r.song_id) === String(songId) && (r.difficulty || '').toLowerCase() === diffNorm,
            );
            const newRecord = {
              song_id: Number(songId),
              difficulty: diffNorm,
              perfect,
              great,
              good,
              bad,
              miss,
              point,
              taken_at: null,
            };
            if (idx >= 0) {
              state.records[idx] = { ...state.records[idx], ...newRecord };
            } else {
              state.records.push(newRecord);
            }
            renderGroups();
            closeDetail();
            alert('APとして記録しました。');
          } catch (e) {
            console.error(e);
            alert('APの記録に失敗しました: ' + (e.message || e));
          }
        };
      }
    }
  }

  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
}

function closeDetail() {
  const modal = $('#record-detail-modal');
  modal.style.display = 'none';
  modal.setAttribute('aria-hidden', 'true');
}

async function init() {
  if (!state.token) {
    loadingEl.style.display = 'none';
    loginRequiredEl.style.display = 'block';
    return;
  }

  try {
    const [meRes, dbRes] = await Promise.all([
      fetch('/api/auth/me', { headers: { Authorization: `Bearer ${state.token}` } }),
      fetch('songDatabase.json'),
    ]);

    const meData = meRes.ok ? await meRes.json().catch(() => ({})) : null;
    if (!meData?.user) {
      state.token = null;
      localStorage.removeItem('prsk_ocr_token');
      loadingEl.style.display = 'none';
      loginRequiredEl.style.display = 'block';
      return;
    }
    state.user = meData.user;

    if (dbRes.ok) state.songDatabase = await dbRes.json();

    const authUser = $('#auth-user');
    if (authUser) authUser.textContent = state.user.username;
    const logoutBtn = $('#auth-logout-btn');
    if (logoutBtn) {
      logoutBtn.style.display = '';
      logoutBtn.addEventListener('click', () => {
        state.token = null;
        state.user = null;
        localStorage.removeItem('prsk_ocr_token');
        window.location.href = 'index.html';
      });
    }

    const data = await apiCall('/api/records');
    state.records = data.records || [];
  } catch (e) {
    console.error(e);
    loadingEl.innerHTML = '<p>読み込みに失敗しました。</p>';
    return;
  }

  loadingEl.style.display = 'none';
  renderGroups();

  $('#record-detail-backdrop')?.addEventListener('click', closeDetail);
  $('#record-detail-close')?.addEventListener('click', closeDetail);
}

init();
