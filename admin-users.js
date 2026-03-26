const state = {
  token: localStorage.getItem('prsk_ocr_token') || null,
  user: null,
};

const $ = (sel) => document.querySelector(sel);

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

function show(id, on) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = on ? '' : 'none';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

async function init() {
  try {
    if (!state.token) throw new Error('Login required');

    const me = await apiCall('/api/auth/me', { method: 'GET', headers: {} });
    if (!me?.user) throw new Error('Login required');
    state.user = me.user;

    const authUser = $('#auth-user');
    if (authUser) authUser.textContent = state.user.username;

    const logoutBtn = $('#auth-logout-btn');
    if (logoutBtn) {
      logoutBtn.style.display = '';
      logoutBtn.addEventListener('click', () => {
        localStorage.removeItem('prsk_ocr_token');
        window.location.href = '/index.html';
      });
    }

    const toMypage = $('#to-mypage');
    if (toMypage) {
      toMypage.href = '/';
    }

    const data = await apiCall('/api/admin/users');
    const users = data.users || [];
    const tbody = $('#admin-users-tbody');
    if (tbody) {
      tbody.innerHTML = users
        .map(
          (u) => `
        <tr>
          <td style="padding:8px; border-bottom:1px solid var(--border-color);">${escapeHtml(u.id)}</td>
          <td style="padding:8px; border-bottom:1px solid var(--border-color);">${escapeHtml(u.username)}</td>
          <td style="padding:8px; border-bottom:1px solid var(--border-color);">${escapeHtml(u.created_at)}</td>
          <td style="padding:8px; border-bottom:1px solid var(--border-color);">
            <a class="btn btn-ghost btn-sm" href="/records/${encodeURIComponent(u.username)}">開く</a>
          </td>
        </tr>
      `,
        )
        .join('');
    }

    show('admin-users-loading', false);
    show('admin-users-content', true);
  } catch (e) {
    console.error(e);
    show('admin-users-loading', false);
    show('admin-users-error', true);
  }
}

init();

