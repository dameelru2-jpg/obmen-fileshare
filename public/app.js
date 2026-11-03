'use strict';

/* ===== Состояние ===== */
const state = {
  groups: [],
  currentGroup: localStorage.getItem('lan-share-group') || 'kadry',
  files: [],
  search: '',
  userName: localStorage.getItem('lan-share-name') || '',
};

const GROUP_META = {
  kadry:     { desc: 'Приказы, личные дела, штатное расписание', icon: 'users' },
  otpusk:    { desc: 'Заявления и графики отпусков',             icon: 'calendar' },
  bolnichny: { desc: 'Листки нетрудоспособности',                icon: 'med' },
  zarplata:  { desc: 'Ведомости, расчётные листы, премии',       icon: 'money' },
  ndfl:      { desc: 'Справки 2-НДФЛ, декларации, вычеты',       icon: 'percent' },
  drugie:    { desc: 'Прочие рабочие документы',                 icon: 'folder' },
};

const ICONS = {
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="3.5"/><path d="M21 21v-2a4 4 0 0 0-3-3.85"/><path d="M15.5 3.6a3.5 3.5 0 0 1 0 6.8"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="m9 15 2 2 4-4"/></svg>',
  med: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12.6 12 20l-7.5-7.4A5 5 0 1 1 12 6.2a5 5 0 1 1 7.5 6.4Z"/><path d="M3.5 12h4l1.5-2.5 2.5 5 1.5-2.5h4"/></svg>',
  money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 12h.01M18 12h.01"/></svg>',
  percent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 5 5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"/><path d="m6 10 6 6 6-6"/><path d="M4 20h16"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ===== Утилиты ===== */
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1).replace('.0', '') + ' КБ';
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1).replace('.0', '') + ' МБ';
  return (bytes / 1024 ** 3).toFixed(2).replace('.00', '') + ' ГБ';
}
function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'только что';
  if (diff < 3600) { const m = Math.floor(diff / 60); return m + ' ' + plural(m, 'минуту', 'минуты', 'минут') + ' назад'; }
  const sameDay = d.toDateString() === now.toDateString();
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return 'сегодня, ' + hm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'вчера, ' + hm;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) + ', ' + hm;
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
function toast(text, isError) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 200ms'; }, 3200);
  setTimeout(() => el.remove(), 3600);
}

/* ===== API ===== */
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) { location.href = '/login.html'; throw new Error('Требуется вход'); }
  if (!r.ok) {
    let msg = 'Ошибка ' + r.status;
    try { msg = (await r.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

async function loadGroups() {
  state.groups = await api('/api/groups');
  renderGroups();
}
async function loadFiles(silent) {
  try {
    const files = await api('/api/files?group=' + state.currentGroup);
    const changed = JSON.stringify(files) !== JSON.stringify(state.files);
    state.files = files;
    if (changed || !silent) renderFiles();
  } catch (e) {
    if (!silent) toast(e.message, true);
  }
}

/* ===== Рендер ===== */
function renderGroups() {
  const nav = $('#groupsNav');
  nav.innerHTML = state.groups.map(g => `
    <button class="group-btn ${g.id === state.currentGroup ? 'active' : ''}" data-group="${g.id}">
      ${ICONS[GROUP_META[g.id]?.icon] || ICONS.folder}
      <span class="group-label">${esc(g.label)}</span>
      <span class="group-count">${g.count}</span>
    </button>`).join('');

  const chips = $('#chipsNav');
  chips.innerHTML = state.groups.map(g => `
    <button class="chip ${g.id === state.currentGroup ? 'active' : ''}" data-group="${g.id}">
      ${esc(g.label)} · ${g.count}
    </button>`).join('');

  const meta = state.groups.find(g => g.id === state.currentGroup);
  $('#groupTitle').textContent = meta ? meta.label : '—';
  $('#groupDesc').textContent = GROUP_META[state.currentGroup]?.desc || '';
}

function renderFiles() {
  const q = state.search.trim().toLowerCase();
  const list = q
    ? state.files.filter(f => f.name.toLowerCase().includes(q) || f.uploader.toLowerCase().includes(q))
    : state.files;
  const box = $('#filesList');

  if (!list.length) {
    const label = state.groups.find(g => g.id === state.currentGroup)?.label || '';
    box.innerHTML = `<div class="empty">
      <div class="empty-title">${q ? 'Ничего не найдено' : 'Пока пусто'}</div>
      <p>${q ? 'Попробуйте изменить запрос.' : 'Загрузите первый файл в группу «' + esc(label) + '» — он сразу появится у всех.'}</p>
    </div>`;
    return;
  }

  box.innerHTML = list.map(f => {
    const ext = (f.name.split('.').pop() || '').slice(0, 5);
    const own = f.uploader === state.userName;
    return `<div class="file-row" data-id="${f.id}">
      <div class="file-icon">${ICONS.file}${ext && ext.length < f.name.length ? `<span class="file-ext">${esc(ext)}</span>` : ''}</div>
      <div class="file-info">
        <div class="file-name" title="${esc(f.name)}">${esc(f.name)}</div>
        <div class="file-meta">
          <span>${esc(f.uploader)}</span><span class="dot">${fmtSize(f.size)}</span><span class="dot">${fmtTime(f.uploadedAt)}</span>
        </div>
      </div>
      <div class="file-actions">
        <a class="action-btn download" href="/api/files/${f.id}/download" download title="Скачать на компьютер">${ICONS.download}<span>Скачать</span></a>
        ${own ? `<button class="action-btn delete" data-del="${f.id}" title="Удалить">${ICONS.trash}<span>Удалить</span></button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function renderUser() {
  const name = state.userName || 'Гость';
  $('#userName').textContent = name;
  const initials = name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  $('#userAvatar').textContent = initials || '—';
}

/* ===== Группа ===== */
function selectGroup(id) {
  state.currentGroup = id;
  localStorage.setItem('lan-share-group', id);
  state.files = [];
  renderGroups();
  renderFiles();
  loadFiles();
}

/* ===== Загрузка ===== */
function ensureName(then) {
  if (state.userName) return then();
  openNameModal(then);
}

function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const prog = $('#progress'), bar = $('#progressBar'), label = $('#progressLabel');
  prog.hidden = false; bar.style.width = '0%';
  $('#uploadBtn').disabled = true;
  const total = files.length;
  let i = 0;

  function sendNext() {
    if (i >= total) {
      prog.hidden = true; $('#uploadBtn').disabled = false;
      toast(total === 1 ? 'Файл загружен и доступен коллегам' : 'Загружено файлов: ' + total);
      loadGroups(); loadFiles(true);
      return;
    }
    const f = files[i];
    label.textContent = 'Загружается: ' + f.name + (total > 1 ? ' (' + (i + 1) + ' из ' + total + ')' : '');
    const url = '/api/upload?group=' + encodeURIComponent(state.currentGroup) +
      '&uploader=' + encodeURIComponent(state.userName) +
      '&name=' + encodeURIComponent(f.name);
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) bar.style.width = Math.round((i + e.loaded / e.total) / total * 100) + '%';
    };
    xhr.onload = () => {
      if (xhr.status === 401) { location.href = '/login.html'; return; }
      if (xhr.status === 201) { i++; sendNext(); return; }
      let msg = 'Ошибка загрузки';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
      prog.hidden = true; $('#uploadBtn').disabled = false;
      toast(msg, true);
    };
    xhr.onerror = () => { prog.hidden = true; $('#uploadBtn').disabled = false; toast('Сеть недоступна', true); };
    xhr.send(f);
  }
  sendNext();
}

/* ===== Удаление ===== */
let pendingDelete = null;
function askDelete(id) {
  const f = state.files.find(x => x.id === id);
  if (!f) return;
  pendingDelete = id;
  $('#confirmText').textContent = '«' + f.name + '» будет удалён для всех пользователей.';
  $('#confirmModal').hidden = false;
  $('#confirmOk').focus();
}
async function doDelete() {
  $('#confirmModal').hidden = true;
  if (!pendingDelete) return;
  try {
    await api('/api/files/' + pendingDelete, { method: 'DELETE', headers: { 'X-User': encodeURIComponent(state.userName) } });
    toast('Файл удалён');
    loadGroups(); loadFiles(true);
  } catch (e) { toast(e.message, true); }
  pendingDelete = null;
}

/* ===== Модалка имени ===== */
let nameThen = null;
function openNameModal(then) {
  nameThen = then || null;
  $('#nameInput').value = state.userName;
  $('#nameModal').hidden = false;
  setTimeout(() => $('#nameInput').focus(), 50);
}
function saveName() {
  const v = $('#nameInput').value.trim();
  if (!v) { $('#nameInput').focus(); return; }
  state.userName = v.slice(0, 60);
  localStorage.setItem('lan-share-name', state.userName);
  $('#nameModal').hidden = true;
  renderUser(); renderFiles();
  const cb = nameThen; nameThen = null;
  if (cb) cb();
}

/* ===== Тема ===== */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('lan-share-theme', t);
}
applyTheme(localStorage.getItem('lan-share-theme') ||
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

/* ===== События ===== */
document.addEventListener('click', (e) => {
  const gb = e.target.closest('[data-group]');
  if (gb) selectGroup(gb.dataset.group);
  const del = e.target.closest('[data-del]');
  if (del) askDelete(del.dataset.del);
});
$('#uploadBtn').addEventListener('click', () => ensureName(() => $('#fileInput').click()));
$('#dropzone').addEventListener('click', () => ensureName(() => $('#fileInput').click()));
$('#dropzone').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ensureName(() => $('#fileInput').click()); }
});
$('#fileInput').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });

const main = $('#main');
['dragenter', 'dragover'].forEach(ev => main.addEventListener(ev, (e) => {
  e.preventDefault(); $('#dropzone').classList.add('dragover');
}));
['dragleave', 'drop'].forEach(ev => main.addEventListener(ev, (e) => {
  e.preventDefault();
  if (ev === 'dragleave' && e.relatedTarget && main.contains(e.relatedTarget)) return;
  $('#dropzone').classList.remove('dragover');
}));
main.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) ensureName(() => uploadFiles(e.dataTransfer.files));
});

$('#searchInput').addEventListener('input', (e) => { state.search = e.target.value; renderFiles(); });
$('#userChip').addEventListener('click', () => openNameModal());
$('#nameSave').addEventListener('click', saveName);
$('#nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); });
$('#confirmOk').addEventListener('click', doDelete);
$('#confirmCancel').addEventListener('click', () => { $('#confirmModal').hidden = true; pendingDelete = null; });
$('#confirmModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) { e.currentTarget.hidden = true; pendingDelete = null; } });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('#confirmModal').hidden = true; pendingDelete = null;
    $('#qrModal').hidden = true;
  }
});
$('#themeToggle').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

/* ===== QR-модалка ===== */
let shareUrl = '';
async function openQr() {
  try {
    const info = await api('/api/server-info');
    const host = (info.ips && info.ips[0]) || location.hostname;
    shareUrl = 'http://' + host + ':' + info.port;
  } catch {
    shareUrl = location.origin;
  }
  $('#qrUrl').textContent = shareUrl;
  const box = $('#qrBox');
  box.innerHTML = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(shareUrl);
    qr.make();
    const img = document.createElement('img');
    img.src = qr.createDataURL(5, 4);
    img.alt = 'QR-код адреса обменника';
    box.appendChild(img);
  } catch {
    box.textContent = 'Не удалось построить QR-код';
  }
  $('#qrModal').hidden = false;
  $('#qrClose').focus();
}
$('#qrBtn').addEventListener('click', openQr);
$('#qrBtnMobile').addEventListener('click', openQr);
$('#qrClose').addEventListener('click', () => { $('#qrModal').hidden = true; });
$('#qrModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
$('#copyUrlBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(shareUrl); toast('Ссылка скопирована'); }
  catch {
    const t = document.createElement('textarea');
    t.value = shareUrl; document.body.appendChild(t); t.select();
    document.execCommand('copy'); t.remove();
    toast('Ссылка скопирована');
  }
});

/* ===== Старт ===== */
renderUser();
(async () => {
  try { await loadGroups(); } catch (e) { toast('Сервер недоступен: ' + e.message, true); }
  await loadFiles();
  if (!state.userName) openNameModal();
})();
setInterval(() => { loadGroups().catch(() => {}); loadFiles(true); }, 4000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadGroups().catch(() => {}); loadFiles(true); } });
