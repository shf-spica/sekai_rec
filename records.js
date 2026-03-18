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
      const appendText = `APPEND: AP ${st.append.ap}/${st.append.total} · FC ${st.append.fc}/${st.append.total}`;
      return `
    <section class="records-level-section" data-level="${g.playLevel}">
      <h2 class="records-level-title">
        <span>Lv.${g.playLevel}</span>
        <span class="records-level-stats">
          <span class="records-level-stat">${escapeHtml(mainText)}</span>
          <span class="records-level-stat">${escapeHtml(appendText)}</span>
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

  if (apBtn) {
    const alreadyAp =
      hasRecord &&
      (recordData?.bad || 0) === 0 &&
      (recordData?.good || 0) === 0 &&
      (recordData?.great || 0) === 0 &&
      (recordData?.miss || 0) === 0;

    if (!state.canEdit || !state.token || alreadyAp) {
      apBtn.style.display = 'none';
      apBtn.onclick = null;
    } else {
      apBtn.style.display = '';
      apBtn.onclick = async () => {
        if (!song || !song.difficulties) {
          alert('この曲の情報が見つかりません（songDatabase.json を確認してください）。');
          return;
        }
        const diffInfo =
          song.difficulties?.[diffNorm] ??
          song.difficulties?.[difficulty] ??
          song.difficulties?.[difficulty?.toLowerCase()];
        let totalNoteCount = null;
        if (typeof diffInfo === 'number') totalNoteCount = diffInfo;
        else if (diffInfo && typeof diffInfo.totalNoteCount === 'number') totalNoteCount = diffInfo.totalNoteCount;
        if (totalNoteCount == null) {
          alert('この曲・難易度の総ノーツ数が不明です（songDatabase.json を確認してください）。');
          return;
        }
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
          // モーダルを閉じ、押したカードだけAP表示に更新
          closeDetail();
          updateOneCard(songId, diffNorm, newRecord);
        } catch (e) {
          console.error(e);
        }
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

async function init() {
  try {
    // /records/{username} から username を取得
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts[0] === 'records' && parts[1]) {
      state.pageUsername = decodeURIComponent(parts[1]);
    }

    const dbRes = await fetch('songDatabase.json');
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
      throw new Error('username not found in path');
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
      authUser.textContent = state.pageUsername + (state.canEdit ? ' (あなた)' : '');
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

    // 編集できない場合は案内を出す
    if (!state.canEdit) {
      loginRequiredEl.style.display = 'block';
    } else {
      loginRequiredEl.style.display = 'none';
    }
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
