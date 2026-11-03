/* Обмен — файлообменник офиса. Клиент v2.
   Аккаунты, папки, превью, поиск, массовое удаление, 8-битный салют. */
(function () {
  'use strict';

  // ---------- состояние ----------
  var state = {
    me: null,              // {username, role, csrf}
    folders: [],           // [{id, name, count}]
    rootCount: 0,
    view: { kind: 'all', id: null },   // all | root | folder | mine
    q: '',
    page: 1,
    files: [],
    hasMore: false,
    total: 0,
    selection: {}          // id -> true (для «Мои файлы»)
  };

  var $ = function (id) { return document.getElementById(id); };
  var groupsNav = $('groupsNav'), chipsNav = $('chipsNav'), filesList = $('filesList');

  // ---------- утилиты ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtSize(n) {
    if (n < 1024) return n + ' Б';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace('.0', '') + ' КБ';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1).replace('.0', '') + ' МБ';
    return (n / 1073741824).toFixed(2).replace(/\.?0+$/, '') + ' ГБ';
  }
  function fmtDate(ms) {
    var d = new Date(ms);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (sameDay) return 'сегодня ' + hm;
    return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear() + ' ' + hm;
  }
  function extOf(name) {
    var m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
    return m ? m[1].toLowerCase() : '';
  }
  function toast(msg, isErr) {
    var box = $('toasts');
    var el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' error' : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, 3400);
  }

  // ---------- API ----------
  function api(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (state.me && state.me.csrf) opts.headers['X-CSRF-Token'] = state.me.csrf;
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json; charset=utf-8';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (r) {
      if (r.status === 401 && path !== '/api/me') { location.href = '/login.html'; throw new Error('unauthorized'); }
      return r.json().then(function (d) {
        if (!r.ok) { var e = new Error(d.error || ('Ошибка ' + r.status)); e.status = r.status; throw e; }
        return d;
      });
    });
  }

  // ---------- тема ----------
  function initTheme() {
    var t = null;
    try { t = localStorage.getItem('obmen_theme'); } catch (e) {}
    if (t) document.documentElement.setAttribute('data-theme', t);
    $('themeToggle').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? '' : 'dark';
      if (cur) document.documentElement.setAttribute('data-theme', cur);
      else document.documentElement.removeAttribute('data-theme');
      try { localStorage.setItem('obmen_theme', cur); } catch (e) {}
    });
  }

  // ---------- навигация (папки) ----------
  var SECTION_ICONS = {
    all: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>',
    mine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/></svg>',
    root: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>'
  };

  function navItems() {
    var items = [
      { kind: 'all', id: null, label: 'Все файлы', icon: SECTION_ICONS.all },
      { kind: 'mine', id: null, label: 'Мои файлы', icon: SECTION_ICONS.mine }
    ];
    state.folders.forEach(function (f) {
      items.push({ kind: 'folder', id: f.id, label: f.name, icon: SECTION_ICONS.folder, count: f.count, folder: true });
    });
    items.push({ kind: 'root', id: null, label: 'Без папки', icon: SECTION_ICONS.root, count: state.rootCount });
    return items;
  }

  function renderNav() {
    var items = navItems();
    var html = '';
    items.forEach(function (it) {
      var active = state.view.kind === it.kind && state.view.id === it.id;
      html += '<button class="group-btn' + (active ? ' active' : '') + '" data-kind="' + it.kind + '" data-id="' + (it.id || '') + '">'
        + it.icon
        + '<span class="group-label">' + esc(it.label) + '</span>'
        + (it.count !== undefined ? '<span class="group-count">' + it.count + '</span>' : '')
        + (it.folder && state.me && state.me.role === 'admin'
            ? '<span class="folder-del" data-del-folder="' + it.id + '" title="Удалить папку" role="button" aria-label="Удалить папку ' + esc(it.label) + '">×</span>' : '')
        + '</button>';
    });
    if (state.me && state.me.role === 'admin') {
      html += '<button class="group-btn folder-add" id="addFolderBtn">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
        + '<span class="group-label">Новая папка</span></button>';
    }
    groupsNav.innerHTML = html;

    // мобильные чипы
    var chips = '';
    items.forEach(function (it) {
      var active = state.view.kind === it.kind && state.view.id === it.id;
      chips += '<button class="chip' + (active ? ' active' : '') + '" data-kind="' + it.kind + '" data-id="' + (it.id || '') + '">'
        + esc(it.label) + (it.count !== undefined ? ' · ' + it.count : '') + '</button>';
    });
    chipsNav.innerHTML = chips;

    groupsNav.querySelectorAll('.group-btn[data-kind]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        if (e.target.closest('.folder-del')) return;
        selectView(b.getAttribute('data-kind'), b.getAttribute('data-id') || null);
      });
    });
    chipsNav.querySelectorAll('.chip').forEach(function (b) {
      b.addEventListener('click', function () {
        selectView(b.getAttribute('data-kind'), b.getAttribute('data-id') || null);
      });
    });
    groupsNav.querySelectorAll('[data-del-folder]').forEach(function (x) {
      x.addEventListener('click', function (e) {
        e.stopPropagation();
        askDeleteFolder(x.getAttribute('data-del-folder'));
      });
    });
    var addBtn = $('addFolderBtn');
    if (addBtn) addBtn.addEventListener('click', function () { openModal('folderModal'); $('folderInput').focus(); });
  }

  function viewTitle() {
    var v = state.view;
    if (v.kind === 'all') return ['Все файлы', 'Всё, что загрузили коллеги'];
    if (v.kind === 'mine') return ['Мои файлы', 'Загруженные вами — можно выделить и удалить'];
    if (v.kind === 'root') return ['Без папки', 'Файлы вне папок'];
    var f = state.folders.filter(function (x) { return x.id === v.id; })[0];
    return [f ? f.name : 'Папка', 'Файл появится у всех коллег'];
  }

  function selectView(kind, id) {
    state.view = { kind: kind, id: id };
    state.page = 1;
    state.files = [];
    state.selection = {};
    var t = viewTitle();
    $('groupTitle').textContent = t[0];
    $('groupDesc').textContent = t[1];
    $('bulkBar').hidden = kind !== 'mine';
    renderNav();
    loadFiles(false);
  }

  // ---------- список файлов ----------
  function filesQuery(page) {
    var p = '/api/files?page=' + page;
    var v = state.view;
    if (v.kind === 'folder') p += '&folder=' + encodeURIComponent(v.id);
    else if (v.kind === 'root') p += '&folder=root';
    if (v.kind === 'mine') p += '&mine=1';
    if (state.q) p += '&q=' + encodeURIComponent(state.q);
    return p;
  }

  function loadFiles(append) {
    return api('GET', filesQuery(state.page)).then(function (d) {
      state.total = d.total;
      state.hasMore = d.hasMore;
      state.files = append ? state.files.concat(d.files) : d.files;
      renderFiles();
      $('loadMoreWrap').hidden = !d.hasMore;
    }).catch(function (e) { if (e.message !== 'unauthorized') toast(e.message, true); });
  }

  function refreshFolders() {
    return api('GET', '/api/folders').then(function (d) {
      state.folders = d.folders;
      state.rootCount = d.rootCount;
      renderNav();
    });
  }

  var FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7"/></svg>';
  var EYE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  var DL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"/><path d="m6 10 6 6 6-6"/><path d="M4 20h16"/></svg>';
  var TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>';

  function renderFiles() {
    if (state.files.length === 0) {
      filesList.innerHTML = '<div class="empty"><div class="empty-title">Пока пусто</div><p>'
        + (state.q ? 'Ничего не найдено по запросу «' + esc(state.q) + '».'
                   : 'Загрузите первый файл — он появится у всех коллег.') + '</p></div>';
      return;
    }
    var mine = state.view.kind === 'mine';
    var html = '';
    state.files.forEach(function (f) {
      var ext = extOf(f.name);
      html += '<div class="file-row" data-id="' + f.id + '">'
        + (mine ? '<label class="file-check"><input type="checkbox" data-check="' + f.id + '"' + (state.selection[f.id] ? ' checked' : '') + ' aria-label="Выбрать файл"></label>' : '')
        + '<div class="file-icon">' + FILE_ICON + (ext ? '<span class="file-ext">' + esc(ext) + '</span>' : '') + '</div>'
        + '<div class="file-info">'
        +   '<div class="file-name" title="' + esc(f.name) + '">' + esc(f.name) + '</div>'
        +   '<div class="file-meta"><span>' + esc(f.uploader) + '</span>'
        +     '<span class="dot">' + fmtSize(f.size) + '</span>'
        +     '<span class="dot">' + fmtDate(f.uploadedAt) + '</span>'
        +     (f.folderName ? '<span class="dot">' + esc(f.folderName) + '</span>' : '')
        +   '</div>'
        + '</div>'
        + '<div class="file-actions">'
        +   (f.preview !== 'none' ? '<button class="action-btn preview" data-preview="' + f.id + '">' + EYE_ICON + '<span>Открыть</span></button>' : '')
        +   '<a class="action-btn download" href="/api/files/' + f.id + '/download">' + DL_ICON + '<span>Скачать</span></a>'
        +   (f.canDelete ? '<button class="action-btn delete" data-del="' + f.id + '" data-name="' + esc(f.name) + '">' + TRASH_ICON + '<span>Удалить</span></button>' : '')
        + '</div>'
        + '</div>';
    });
    filesList.innerHTML = html;

    filesList.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () { askDeleteFile(b.getAttribute('data-del'), b.getAttribute('data-name')); });
    });
    filesList.querySelectorAll('[data-preview]').forEach(function (b) {
      b.addEventListener('click', function () { openPreview(b.getAttribute('data-preview')); });
    });
    filesList.querySelectorAll('[data-check]').forEach(function (c) {
      c.addEventListener('change', function () {
        if (c.checked) state.selection[c.getAttribute('data-check')] = true;
        else delete state.selection[c.getAttribute('data-check')];
        updateBulkBar();
      });
    });
    updateBulkBar();
  }

  // ---------- массовое удаление ----------
  function selectedIds() { return Object.keys(state.selection); }
  function updateBulkBar() {
    if (state.view.kind !== 'mine') return;
    var n = selectedIds().length;
    $('bulkCount').textContent = 'Выбрано: ' + n;
    $('bulkDelete').disabled = n === 0;
  }

  function initBulk() {
    $('bulkAll').addEventListener('change', function () {
      var on = $('bulkAll').checked;
      state.selection = {};
      if (on) state.files.forEach(function (f) { state.selection[f.id] = true; });
      renderFiles();
    });
    $('bulkDelete').addEventListener('click', function () {
      var ids = selectedIds();
      if (!ids.length) return;
      askConfirm(
        'Удалить выбранные файлы?',
        'Будет удалено файлов: ' + ids.length + '. Действие необратимо.',
        'Удалить',
        function () {
          api('POST', '/api/files/bulk-delete', { ids: ids }).then(function (d) {
            toast('Удалено файлов: ' + d.deleted + (d.denied ? ', отказано: ' + d.denied : ''));
            state.selection = {};
            $('bulkAll').checked = false;
            state.page = 1;
            loadFiles(false);
            refreshFolders();
          }).catch(function (e) { toast(e.message, true); });
        });
    });
  }

  // ---------- загрузка ----------
  function currentFolderParam() {
    var v = state.view;
    if (v.kind === 'folder') return v.id;
    if (v.kind === 'root') return 'root';
    // «Все файлы» и «Мои файлы» — загружаем в корень
    return 'root';
  }

  var uploadQueue = [];
  var uploading = false;
  var uploadedCount = 0;

  function enqueueUploads(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    uploadQueue = uploadQueue.concat(files);
    if (!uploading) {
      uploadedCount = 0;
      $('progress').hidden = false;
      pumpQueue();
    }
  }

  function pumpQueue() {
    var file = uploadQueue.shift();
    if (!file) {
      uploading = false;
      $('progress').hidden = true;
      $('progressBar').style.width = '0%';
      state.page = 1;
      loadFiles(false);
      refreshFolders();
      if (uploadedCount > 0) {
        toast(uploadedCount === 1 ? 'Файл загружен' : 'Загружено файлов: ' + uploadedCount);
        if (window.obmenFirework) window.obmenFirework();
      }
      return;
    }
    uploading = true;
    $('progressLabel').textContent = 'Загрузка: ' + file.name;
    var xhr = new XMLHttpRequest();
    xhr.open('PUT', '/api/upload?folder=' + encodeURIComponent(currentFolderParam()) + '&name=' + encodeURIComponent(file.name));
    xhr.setRequestHeader('X-CSRF-Token', state.me.csrf);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) $('progressBar').style.width = Math.round(e.loaded / e.total * 100) + '%';
    };
    xhr.onload = function () {
      if (xhr.status === 201) {
        uploadedCount++;
      } else {
        var msg = 'Не удалось загрузить «' + file.name + '»';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) {}
        toast(msg, true);
      }
      pumpQueue();
    };
    xhr.onerror = function () {
      toast('Сеть недоступна при загрузке «' + file.name + '»', true);
      pumpQueue();
    };
    xhr.send(file);
  }

  function initUpload() {
    var dz = $('dropzone'), fi = $('fileInput');
    $('uploadBtn').addEventListener('click', function () { fi.click(); });
    dz.addEventListener('click', function () { fi.click(); });
    dz.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
    fi.addEventListener('change', function () { enqueueUploads(fi.files); fi.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
    });
    dz.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) enqueueUploads(e.dataTransfer.files);
    });
  }

  // ---------- предпросмотр ----------
  function openPreview(id) {
    var f = state.files.filter(function (x) { return x.id === id; })[0];
    if (!f) return;
    $('previewTitle').textContent = f.name;
    var body = $('previewBody');
    body.innerHTML = '<div class="preview-loading">Загрузка…</div>';
    openModal('previewModal');
    var url = '/api/files/' + id + '/preview';
    if (f.preview === 'image') {
      var img = new Image();
      img.className = 'preview-img';
      img.alt = f.name;
      img.onload = function () { body.innerHTML = ''; body.appendChild(img); };
      img.onerror = function () { body.innerHTML = '<div class="preview-loading">Не удалось показать изображение</div>'; };
      img.src = url;
    } else if (f.preview === 'pdf') {
      body.innerHTML = '';
      var fr = document.createElement('iframe');
      fr.className = 'preview-frame';
      fr.src = url;
      fr.title = f.name;
      body.appendChild(fr);
    } else if (f.preview === 'text') {
      fetch(url, { credentials: 'same-origin' }).then(function (r) {
        if (!r.ok) throw new Error('preview ' + r.status);
        return r.text();
      }).then(function (text) {
        var pre = document.createElement('pre');
        pre.className = 'preview-text';
        pre.textContent = text.slice(0, 200000); // только textContent — никакого HTML
        body.innerHTML = '';
        body.appendChild(pre);
      }).catch(function () {
        body.innerHTML = '<div class="preview-loading">Не удалось показать файл</div>';
      });
    }
  }

  // ---------- удаление ----------
  var confirmAction = null;
  function askConfirm(title, text, okLabel, fn) {
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmOk').textContent = okLabel;
    confirmAction = fn;
    openModal('confirmModal');
  }
  function askDeleteFile(id, name) {
    askConfirm('Удалить файл?', '«' + name + '» исчезнет у всех коллег. Действие необратимо.', 'Удалить', function () {
      api('DELETE', '/api/files/' + id).then(function () {
        toast('Файл удалён');
        state.page = 1;
        loadFiles(false);
        refreshFolders();
      }).catch(function (e) { toast(e.message, true); });
    });
  }
  function askDeleteFolder(id) {
    var f = state.folders.filter(function (x) { return x.id === id; })[0];
    if (!f) return;
    askConfirm('Удалить папку?', '«' + f.name + '» будет удалена, файлы переедут в раздел «Без папки».', 'Удалить папку', function () {
      api('DELETE', '/api/folders/' + id).then(function () {
        toast('Папка удалена');
        if (state.view.kind === 'folder' && state.view.id === id) {
          selectView('all', null);
        }
        refreshFolders();
      }).catch(function (e) { toast(e.message, true); });
    });
  }

  // ---------- папки (admin) ----------
  function initFolders() {
    $('folderSave').addEventListener('click', createFolder);
    $('folderInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') createFolder(); });
    $('folderCancel').addEventListener('click', function () { closeModal('folderModal'); });
    function createFolder() {
      var name = $('folderInput').value.trim();
      if (name.length < 2) { toast('Название папки — минимум 2 символа', true); return; }
      api('POST', '/api/folders', { name: name }).then(function () {
        toast('Папка «' + name + '» создана');
        $('folderInput').value = '';
        closeModal('folderModal');
        refreshFolders();
      }).catch(function (e) { toast(e.message, true); });
    }
  }

  // ---------- модалки ----------
  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) {
    $(id).hidden = true;
    if (id === 'previewModal') $('previewBody').innerHTML = '';
  }
  function initModals() {
    $('confirmOk').addEventListener('click', function () {
      closeModal('confirmModal');
      if (confirmAction) { var fn = confirmAction; confirmAction = null; fn(); }
    });
    $('confirmCancel').addEventListener('click', function () { closeModal('confirmModal'); });
    $('previewClose').addEventListener('click', function () { closeModal('previewModal'); });
    document.querySelectorAll('.modal-backdrop').forEach(function (b) {
      b.addEventListener('click', function (e) { if (e.target === b) closeModal(b.id); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        ['confirmModal', 'folderModal', 'previewModal', 'qrModal'].forEach(function (id) {
          if (!$(id).hidden) closeModal(id);
        });
      }
    });
  }

  // ---------- QR ----------
  function initQr() {
    function showQr() {
      api('GET', '/api/server-info').then(function (d) {
        var host = location.hostname;
        var url;
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && host !== '127.0.0.1') url = location.origin + '/';
        else url = (d.addresses && d.addresses[0]) || (location.origin + '/');
        $('qrUrl').textContent = url;
        var box = $('qrBox');
        box.innerHTML = '';
        if (typeof QRCode !== 'undefined') {
          new QRCode(box, { text: url, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
        }
        openModal('qrModal');
      }).catch(function (e) { toast(e.message, true); });
    }
    $('qrBtn').addEventListener('click', showQr);
    $('qrBtnMobile').addEventListener('click', showQr);
    $('qrClose').addEventListener('click', function () { closeModal('qrModal'); });
    $('copyUrlBtn').addEventListener('click', function () {
      var url = $('qrUrl').textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast('Ссылка скопирована'); });
    });
  }

  // ---------- поиск ----------
  function initSearch() {
    var timer = null;
    $('searchInput').addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        state.q = $('searchInput').value.trim();
        state.page = 1;
        loadFiles(false);
      }, 300);
    });
  }

  function initLoadMore() {
    $('loadMoreBtn').addEventListener('click', function () {
      state.page++;
      loadFiles(true);
    });
  }

  // ---------- вход/выход ----------
  function initUser() {
    $('logoutBtn').addEventListener('click', function () {
      api('POST', '/api/logout').catch(function () {}).then(function () {
        try { sessionStorage.removeItem('obmen_csrf'); } catch (e) {}
        location.href = '/login.html';
      });
    });
  }

  // ---------- запуск ----------
  function boot() {
    initTheme();
    api('GET', '/api/me').then(function (me) {
      state.me = me;
      try { sessionStorage.setItem('obmen_csrf', me.csrf); } catch (e) {}
      $('userName').textContent = me.username;
      $('userAvatar').textContent = me.username.slice(0, 1).toUpperCase();
      $('userChip').title = me.username + (me.role === 'admin' ? ' · администратор' : '');
      if (me.role === 'admin') $('roleBadge').hidden = false;

      initModals();
      initUpload();
      initBulk();
      initFolders();
      initQr();
      initSearch();
      initLoadMore();
      initUser();

      refreshFolders().then(function () { selectView('all', null); });
    }).catch(function (e) {
      if (e.message !== 'unauthorized') toast(e.message, true);
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
