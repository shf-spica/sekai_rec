/**
 * 案内・マイページ用のログイン / 新規登録（localStorage の prsk_ocr_token と同期）
 * ocr の app.js は従来どおり独立（同一トークンキーを共有）。
 */

const STORAGE_KEY = 'prsk_ocr_token';

function formatApiDetail(detail) {
  if (detail == null) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((e) => (e && typeof e === 'object' && e.msg != null ? String(e.msg) : JSON.stringify(e)))
      .join(' / ');
  }
  if (typeof detail === 'object') return detail.msg != null ? String(detail.msg) : JSON.stringify(detail);
  return String(detail);
}

/**
 * @param {object} [options]
 * @param {HTMLElement | null} [options.recordsLinkEl] — #records-link など
 * @param {string | null} [options.afterLoginNavigate] — ログイン成功後に location.href（afterLogin より後）
 * @param {(user: { username: string }) => void} [options.afterLogin]
 * @param {() => void} [options.onLogout]
 */
export function mountStandaloneAuth(options = {}) {
  const { recordsLinkEl = null, afterLoginNavigate = null, afterLogin = null, onLogout = null } = options;

  const authUser = document.getElementById('auth-user');
  const authLoginBtn = document.getElementById('auth-login-btn');
  const authRegisterBtn = document.getElementById('auth-register-btn');
  const authLogoutBtn = document.getElementById('auth-logout-btn');
  const linkEl = recordsLinkEl || document.getElementById('records-link');
  const authModal = document.getElementById('auth-modal');
  const authModalTitle = document.getElementById('auth-modal-title');
  const authForm = document.getElementById('auth-form');
  const authUsername = document.getElementById('auth-username');
  const authPassword = document.getElementById('auth-password');
  const authError = document.getElementById('auth-error');
  const authModalBackdrop = document.getElementById('auth-modal-backdrop');
  const authModalCancel = document.getElementById('auth-modal-cancel');
  const authSubmit = document.getElementById('auth-submit');

  let token = localStorage.getItem(STORAGE_KEY) || null;
  let user = null;
  let listenersBound = false;

  function renderAuthArea() {
    if (!authLoginBtn || !authRegisterBtn || !authLogoutBtn) return;
    if (user) {
      if (authUser) {
        authUser.textContent = user.username;
        authUser.style.display = '';
      }
      authLoginBtn.style.display = 'none';
      authRegisterBtn.style.display = 'none';
      authLogoutBtn.style.display = '';
      if (linkEl) linkEl.href = `/records/${encodeURIComponent(user.username)}`;
    } else {
      if (authUser) authUser.style.display = 'none';
      authLogoutBtn.style.display = 'none';
      authLoginBtn.style.display = '';
      authRegisterBtn.style.display = '';
      if (linkEl) linkEl.href = '/records/me';
    }
  }

  async function hydrateUser() {
    if (!token) {
      user = null;
      return;
    }
    const res = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => ({}));
    if (data?.user) {
      user = data.user;
    } else {
      token = null;
      user = null;
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  function openAuthModal(mode) {
    if (!authModal || !authForm) return;
    authModal.dataset.mode = mode;
    if (authModalTitle) authModalTitle.textContent = mode === 'register' ? '新規登録' : 'ログイン';
    if (authSubmit) authSubmit.textContent = mode === 'register' ? '登録' : 'ログイン';
    if (authUsername) authUsername.value = '';
    if (authPassword) authPassword.value = '';
    if (authError) authError.textContent = '';
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
    if (authError) authError.textContent = '';
    try {
      const mode = authModal?.dataset.mode || 'login';
      const username = (authUsername?.value || '').trim();
      const password = authPassword?.value || '';
      if (username.length < 2) {
        if (authError) authError.textContent = 'ユーザー名は2文字以上です';
        return;
      }
      if (password.length < 6) {
        if (authError) authError.textContent = 'パスワードは6文字以上です';
        return;
      }
      const path = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (authError) authError.textContent = formatApiDetail(data.detail) || res.statusText || '失敗しました';
        return;
      }
      const newToken = data.access_token != null ? String(data.access_token) : '';
      if (newToken && data.user) {
        token = newToken;
        user = data.user;
        localStorage.setItem(STORAGE_KEY, token);
        closeAuthModal();
        renderAuthArea();
        if (typeof afterLogin === 'function') afterLogin(user);
        else if (afterLoginNavigate) window.location.href = afterLoginNavigate;
      } else if (authError) {
        authError.textContent = '応答が不正です（トークンがありません）';
      }
    } catch (err) {
      if (authError) authError.textContent = err.message || '通信エラー';
    } finally {
      if (authSubmit) authSubmit.disabled = false;
    }
  }

  function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;
    if (authLoginBtn) authLoginBtn.addEventListener('click', () => openAuthModal('login'));
    if (authRegisterBtn) authRegisterBtn.addEventListener('click', () => openAuthModal('register'));
    if (authLogoutBtn) {
      authLogoutBtn.addEventListener('click', () => {
        token = null;
        user = null;
        localStorage.removeItem(STORAGE_KEY);
        renderAuthArea();
        if (typeof onLogout === 'function') onLogout();
      });
    }
    if (authModalBackdrop) authModalBackdrop.addEventListener('click', closeAuthModal);
    if (authModalCancel) authModalCancel.addEventListener('click', closeAuthModal);
    if (authForm) authForm.addEventListener('submit', submitAuth);
  }

  return {
    async init() {
      await hydrateUser();
      bindListeners();
      renderAuthArea();
    },
    openAuthModal,
    closeAuthModal,
    getToken: () => token,
    getUser: () => user,
  };
}
