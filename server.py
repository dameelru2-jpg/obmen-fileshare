# -*- coding: utf-8 -*-
"""
Обмен — локальный файлообменник офиса. v2.
Однофайловый сервер на стандартной библиотеке Python + SQLite.
Собирается в один .exe через PyInstaller.

Аккаунты: регистрация по паролю-приглашению (password.txt), уникальные ники.
Первый зарегистрированный пользователь — администратор (создаёт папки).
Сессии — подписанные cookie, не привязаны к IP (устойчиво к смене VPN).
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sqlite3
import sys
import threading
import time
import socket
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote, quote

# --- пути ---
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
    PUBLIC_DIR = os.path.join(sys._MEIPASS, 'public')
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    PUBLIC_DIR = os.path.join(BASE_DIR, 'public')

DATA_DIR = os.path.join(BASE_DIR, 'uploads')
FILES_DIR = os.path.join(DATA_DIR, 'files')
DB_PATH = os.path.join(DATA_DIR, 'obmen.db')
LEGACY_META = os.path.join(DATA_DIR, 'meta.json')
PASSWORD_PATH = os.path.join(BASE_DIR, 'password.txt')
SETTINGS_PATH = os.path.join(BASE_DIR, 'settings.json')
AUDIT_PATH = os.path.join(DATA_DIR, 'audit.log')

os.makedirs(FILES_DIR, exist_ok=True)

MAX_UPLOAD = 500 * 1024 * 1024
SESSION_TTL = 30 * 24 * 3600  # 30 дней — переживает смену IP/VPN
PAGE_SIZE = 20

SEED_FOLDERS = ['Кадры', 'Отпуск', 'Больничный', 'Расчёт зарплаты', 'НДФЛ', 'Другие']
GROUP_TO_FOLDER = {  # миграция старых групп
    'kadry': 'Кадры', 'otpusk': 'Отпуск', 'bolnichny': 'Больничный',
    'zarplata': 'Расчёт зарплаты', 'ndfl': 'НДФЛ', 'drugie': 'Другие',
}
PREVIEW_IMAGE = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'}
PREVIEW_TEXT = {'.txt', '.md', '.csv', '.log', '.json', '.xml', '.ini', '.cfg'}
PREVIEW_PDF = {'.pdf'}
FORCE_DOWNLOAD = {'.html', '.htm', '.js', '.svg'}  # потенциально активный контент — только скачивание

MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.woff': 'font/woff',
    '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
}

# ---------- настройки ----------
def load_settings():
    try:
        with open(SETTINGS_PATH, 'r', encoding='utf-8') as f:
            s = json.load(f)
    except Exception:
        s = {}
    if 'retention_days' not in s:
        s['retention_days'] = 7
        try:
            with open(SETTINGS_PATH, 'w', encoding='utf-8') as f:
                json.dump(s, f, ensure_ascii=False, indent=2)
        except OSError:
            pass
    return s

SETTINGS = load_settings()

# ---------- пароль-приглашение ----------
PASSWORD = ''
def init_password(cli_pw=None):
    global PASSWORD
    pw = cli_pw or os.environ.get('OBMEN_PASSWORD')
    if not pw and os.path.exists(PASSWORD_PATH):
        with open(PASSWORD_PATH, 'r', encoding='utf-8') as f:
            pw = f.read().strip()
    if not pw:
        pw = secrets.token_urlsafe(9)
        with open(PASSWORD_PATH, 'w', encoding='utf-8') as f:
            f.write(pw + '\n')
    PASSWORD = pw

# ---------- БД ----------
_db_lock = threading.Lock()

def db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys=ON')
    return conn

def init_db():
    with _db_lock, db() as c:
        c.executescript('''
        CREATE TABLE IF NOT EXISTS users(
          id TEXT PRIMARY KEY,
          username TEXT,
          username_fold TEXT UNIQUE,
          pass_hash TEXT, salt TEXT,
          role TEXT CHECK(role IN ('user','admin','system')) DEFAULT 'user',
          created_at INTEGER);
        CREATE TABLE IF NOT EXISTS sessions(
          token TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id),
          csrf TEXT, expires_at INTEGER);
        CREATE TABLE IF NOT EXISTS folders(
          id TEXT PRIMARY KEY, name TEXT, name_fold TEXT UNIQUE,
          created_by TEXT, created_at INTEGER);
        CREATE TABLE IF NOT EXISTS files(
          id TEXT PRIMARY KEY,
          user_id TEXT REFERENCES users(id),
          folder_id TEXT REFERENCES folders(id),
          name TEXT, mime TEXT, size INTEGER, uploaded_at INTEGER);
        CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
        CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
        CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
        ''')
        # системный пользователь для архивных файлов
        if not c.execute("SELECT 1 FROM users WHERE id='system'").fetchone():
            c.execute("INSERT INTO users VALUES('system','Архив','архив','','',  'system',?)",
                      (int(time.time() * 1000),))
        # стартовые папки
        for name in SEED_FOLDERS:
            if not c.execute('SELECT 1 FROM folders WHERE name_fold=?', (name.casefold(),)).fetchone():
                c.execute('INSERT INTO folders VALUES(?,?,?,?,?)',
                          (str(uuid.uuid4()), name, name.casefold(), 'system', int(time.time() * 1000)))

def migrate_legacy():
    """Импорт файлов из старой meta.json: владелец → системный 'Архив', группа → папка."""
    if not os.path.exists(LEGACY_META):
        return
    try:
        with open(LEGACY_META, 'r', encoding='utf-8') as f:
            legacy = json.load(f)
    except Exception:
        return
    if not legacy:
        return
    with _db_lock, db() as c:
        if c.execute('SELECT COUNT(*) n FROM files').fetchone()['n'] > 0:
            return
        n = 0
        for rec in legacy:
            if c.execute('SELECT 1 FROM files WHERE id=?', (rec['id'],)).fetchone():
                continue
            folder_name = GROUP_TO_FOLDER.get(rec.get('group'), 'Другие')
            row = c.execute('SELECT id FROM folders WHERE name=?', (folder_name,)).fetchone()
            c.execute('INSERT INTO files VALUES(?,?,?,?,?,?,?)',
                      (rec['id'], 'system', row['id'], rec['name'][:255], '',
                       int(rec.get('size', 0)), int(rec.get('uploadedAt', 0))))
            n += 1
    if n:
        audit('system', 'migrate', f'импортировано файлов: {n}')
    os.replace(LEGACY_META, LEGACY_META + '.migrated')

# ---------- аудит ----------
def audit(user, action, detail=''):
    try:
        line = '%s  %-12s  %-16s  %s\n' % (
            time.strftime('%Y-%m-%d %H:%M:%S'), user, action, detail)
        with open(AUDIT_PATH, 'a', encoding='utf-8') as f:
            f.write(line)
    except OSError:
        pass

# ---------- пароли/сессии ----------
def hash_password(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac('sha256', pw.encode('utf-8'), bytes.fromhex(salt), 200_000)
    return h.hex(), salt

def create_session(user_id):
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(24)
    exp = int(time.time()) + SESSION_TTL
    with _db_lock, db() as c:
        c.execute('DELETE FROM sessions WHERE expires_at<?', (int(time.time()),))
        c.execute('INSERT INTO sessions VALUES(?,?,?,?)', (token, user_id, csrf, exp))
    return token, csrf, exp

def get_session(token):
    if not token:
        return None
    with _db_lock, db() as c:
        row = c.execute('''SELECT s.token, s.csrf, s.expires_at, u.id, u.username, u.role
                           FROM sessions s JOIN users u ON u.id=s.user_id
                           WHERE s.token=?''', (token,)).fetchone()
    if not row or row['expires_at'] < int(time.time()):
        return None
    return row

# ---------- rate limiting (в памяти) ----------
_rl_lock = threading.Lock()
_rl = {}
def rate_ok(key, limit, per_sec):
    now = time.time()
    with _rl_lock:
        lst = [t for t in _rl.get(key, []) if now - t < per_sec]
        if len(lst) >= limit:
            _rl[key] = lst
            return False
        lst.append(now)
        _rl[key] = lst
        return True

# ---------- автоочистка старых файлов ----------
def retention_sweep():
    days = int(SETTINGS.get('retention_days', 7))
    if days <= 0:
        return
    cutoff = int((time.time() - days * 86400) * 1000)
    with _db_lock, db() as c:
        old = c.execute('SELECT id, name FROM files WHERE uploaded_at<? AND uploaded_at>0', (cutoff,)).fetchall()
        for r in old:
            try: os.unlink(os.path.join(FILES_DIR, r['id']))
            except OSError: pass
            c.execute('DELETE FROM files WHERE id=?', (r['id'],))
            audit('system', 'auto-delete', r['name'])

def sweeper_loop():
    while True:
        time.sleep(3600)
        try: retention_sweep()
        except Exception: pass


def lan_ips():
    ips = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith('127.') and ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    return ips

def file_public(row, me):
    ext = os.path.splitext(row['name'])[1].lower()
    if ext in PREVIEW_PDF: ptype = 'pdf'
    elif ext in PREVIEW_IMAGE and ext not in FORCE_DOWNLOAD: ptype = 'image'
    elif ext in PREVIEW_TEXT: ptype = 'text'
    else: ptype = 'none'
    return {
        'id': row['id'], 'name': row['name'], 'size': row['size'],
        'uploader': row['username'], 'folder': row['folder_id'],
        'folderName': row['folder_name'], 'uploadedAt': row['uploaded_at'],
        'preview': ptype,
        'canDelete': me and (me['role'] == 'admin' or me['id'] == row['user_id']),
    }

FILE_SELECT = '''SELECT f.*, u.username, COALESCE(fo.name,'') folder_name
                 FROM files f JOIN users u ON u.id=f.user_id
                 LEFT JOIN folders fo ON fo.id=f.folder_id'''

class Handler(BaseHTTPRequestHandler):
    server_version = 'ObmenFileshare/2.0'
    protocol_version = 'HTTP/1.1'

    # --- helpers ---
    def _send_json(self, obj, status=200, extra_headers=None):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _err(self, status, msg):
        self._send_json({'error': msg}, status)

    def log_message(self, fmt, *args):
        pass

    def _client_ip(self):
        return self.client_address[0] if self.client_address else '?'

    def _session(self):
        cookie = self.headers.get('Cookie') or ''
        m = re.search(r'(?:^|;\s*)obmen_session=([\w-]{20,80})', cookie)
        return get_session(m.group(1)) if m else None

    def _check_csrf(self, sess):
        """Мутирующие запросы требуют заголовок X-CSRF-Token из сессии."""
        hdr = self.headers.get('X-CSRF-Token') or ''
        return bool(sess) and hmac.compare_digest(hdr, sess['csrf'])

    def _read_json(self, limit=8192):
        length = int(self.headers.get('Content-Length') or 0)
        if not length:
            return {}
        raw = self.rfile.read(min(length, limit))
        for enc in ('utf-8', 'cp1251'):
            try:
                return json.loads(raw.decode(enc))
            except Exception:
                continue
        return {}

    # ================= POST =================
    def do_POST(self):
        path = urlparse(self.path).path
        ip = self._client_ip()

        if path == '/api/register':
            if not rate_ok('reg:' + ip, 10, 60):
                return self._err(429, 'Слишком много попыток, подождите минуту')
            d = self._read_json()
            username = str(d.get('username', '')).strip()
            pw = str(d.get('password', ''))
            invite = str(d.get('invite', ''))
            if not hmac.compare_digest(invite.encode(), PASSWORD.encode()):
                time.sleep(0.7)
                return self._err(403, 'Неверный пароль-приглашение')
            if not re.fullmatch(r'[\w .\-]{2,40}', username, flags=re.UNICODE):
                return self._err(400, 'Ник: 2–40 символов (буквы, цифры, пробел, . - _)')
            if len(pw) < 6:
                return self._err(400, 'Пароль — минимум 6 символов')
            ph, salt = hash_password(pw)
            with _db_lock, db() as c:
                if c.execute('SELECT 1 FROM users WHERE username_fold=?', (username.casefold(),)).fetchone():
                    return self._err(409, 'Такой ник уже занят')
                is_first = c.execute("SELECT COUNT(*) n FROM users WHERE role!='system'").fetchone()['n'] == 0
                uid = str(uuid.uuid4())
                role = 'admin' if is_first else 'user'
                try:
                    c.execute('INSERT INTO users VALUES(?,?,?,?,?,?,?)',
                              (uid, username, username.casefold(), ph, salt, role, int(time.time() * 1000)))
                except sqlite3.IntegrityError:
                    return self._err(409, 'Такой ник уже занят')
            token, csrf, exp = create_session(uid)
            audit(username, 'register', 'роль ' + role)
            cookie = 'obmen_session=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d' % (token, SESSION_TTL)
            return self._send_json({'ok': True, 'username': username, 'role': role, 'csrf': csrf},
                                   extra_headers={'Set-Cookie': cookie})

        if path == '/api/login':
            if not rate_ok('login:' + ip, 5, 60):
                return self._err(429, 'Слишком много попыток, подождите минуту')
            d = self._read_json()
            username = str(d.get('username', '')).strip()
            pw = str(d.get('password', ''))
            with _db_lock, db() as c:
                row = c.execute("SELECT * FROM users WHERE username_fold=? AND role!='system'",
                                (username.casefold(),)).fetchone()
            ok = False
            if row and row['salt']:
                ph, _ = hash_password(pw, row['salt'])
                ok = hmac.compare_digest(ph, row['pass_hash'])
            else:
                hash_password(pw)  # выравнивание времени
            if not ok:
                time.sleep(0.5)
                return self._err(401, 'Неверный ник или пароль')
            token, csrf, exp = create_session(row['id'])
            audit(username, 'login', '')
            cookie = 'obmen_session=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d' % (token, SESSION_TTL)
            return self._send_json({'ok': True, 'username': row['username'], 'role': row['role'], 'csrf': csrf},
                                   extra_headers={'Set-Cookie': cookie})

        if path == '/api/logout':
            sess = self._session()
            if sess:
                with _db_lock, db() as c:
                    c.execute('DELETE FROM sessions WHERE token=?', (sess['token'],))
            return self._send_json({'ok': True}, extra_headers={
                'Set-Cookie': 'obmen_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'})

        if path == '/api/folders':
            sess = self._session()
            if not sess:
                return self._err(401, 'Требуется вход')
            if not self._check_csrf(sess):
                return self._err(403, 'CSRF-проверка не пройдена')
            if sess['role'] != 'admin':
                return self._err(403, 'Создавать папки может только администратор')
            name = str(self._read_json().get('name', '')).strip()
            if not re.fullmatch(r'[\w .\-()№]{2,60}', name, flags=re.UNICODE):
                return self._err(400, 'Название папки: 2–60 символов (буквы, цифры, пробел, . - ( ))')
            with _db_lock, db() as c:
                if c.execute('SELECT 1 FROM folders WHERE name_fold=?', (name.casefold(),)).fetchone():
                    return self._err(409, 'Папка с таким названием уже есть')
                fid = str(uuid.uuid4())
                try:
                    c.execute('INSERT INTO folders VALUES(?,?,?,?,?)',
                              (fid, name, name.casefold(), sess['id'], int(time.time() * 1000)))
                except sqlite3.IntegrityError:
                    return self._err(409, 'Папка с таким названием уже есть')
            audit(sess['username'], 'folder-create', name)
            return self._send_json({'id': fid, 'name': name}, 201)

        if path == '/api/files/bulk-delete':
            sess = self._session()
            if not sess:
                return self._err(401, 'Требуется вход')
            if not self._check_csrf(sess):
                return self._err(403, 'CSRF-проверка не пройдена')
            ids = self._read_json().get('ids', [])
            if not isinstance(ids, list) or len(ids) > 200:
                return self._err(400, 'Некорректный список')
            deleted, denied = 0, 0
            with _db_lock, db() as c:
                for fid in ids:
                    row = c.execute('SELECT * FROM files WHERE id=?', (str(fid),)).fetchone()
                    if not row:
                        continue
                    if sess['role'] != 'admin' and row['user_id'] != sess['id']:
                        denied += 1
                        continue
                    try: os.unlink(os.path.join(FILES_DIR, row['id']))
                    except OSError: pass
                    c.execute('DELETE FROM files WHERE id=?', (row['id'],))
                    deleted += 1
                    audit(sess['username'], 'delete', row['name'])
            return self._send_json({'deleted': deleted, 'denied': denied})

        return self._err(404, 'Не найдено')

    # ================= PUT (загрузка файла) =================
    def do_PUT(self):
        parsed = urlparse(self.path)
        if parsed.path != '/api/upload':
            return self._err(404, 'Не найдено')
        sess = self._session()
        if not sess:
            self.close_connection = True
            return self._err(401, 'Требуется вход')
        if not self._check_csrf(sess):
            self.close_connection = True
            return self._err(403, 'CSRF-проверка не пройдена')
        if not rate_ok('upload:' + sess['id'], 60, 60):
            self.close_connection = True
            return self._err(429, 'Слишком много загрузок, подождите минуту')

        qs = parse_qs(parsed.query)
        folder = (qs.get('folder') or ['root'])[0]
        name = (os.path.basename((qs.get('name') or ['file'])[0]) or 'file')[:255]

        with _db_lock, db() as c:
            if folder == 'root':
                folder_id = None
            else:
                row = c.execute('SELECT id FROM folders WHERE id=?', (folder,)).fetchone()
                if not row:
                    self.close_connection = True
                    return self._err(400, 'Неизвестная папка')
                folder_id = row['id']

        length_hdr = self.headers.get('Content-Length')
        if length_hdr is None:
            self.close_connection = True
            return self._err(400, 'Нет тела запроса')
        length = int(length_hdr)
        if length > MAX_UPLOAD:
            self.close_connection = True
            return self._err(413, 'Файл больше 500 МБ')

        fid = str(uuid.uuid4())
        fpath = os.path.join(FILES_DIR, fid)
        try:
            remaining = length
            with open(fpath, 'wb') as out:
                while remaining > 0:
                    chunk = self.rfile.read(min(256 * 1024, remaining))
                    if not chunk:
                        break
                    out.write(chunk)
                    remaining -= len(chunk)
            if remaining > 0:
                os.unlink(fpath)
                self.close_connection = True
                return self._err(400, 'Загрузка оборвалась')
        except Exception:
            try: os.unlink(fpath)
            except OSError: pass
            self.close_connection = True
            return self._err(500, 'Не удалось сохранить файл')

        mime = MIME.get(os.path.splitext(name)[1].lower(), 'application/octet-stream')
        with _db_lock, db() as c:
            c.execute('INSERT INTO files VALUES(?,?,?,?,?,?,?)',
                      (fid, sess['id'], folder_id, name, mime, length, int(time.time() * 1000)))
        audit(sess['username'], 'upload', name)
        with _db_lock, db() as c:
            row = c.execute(FILE_SELECT + ' WHERE f.id=?', (fid,)).fetchone()
        self._send_json([file_public(row, sess)], 201)

    # ================= GET =================
    PUBLIC_PATHS = {'/login.html', '/styles.css', '/favicon.ico'}

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        sess = self._session()

        # ----- API -----
        if path == '/api/me':
            if not sess:
                return self._err(401, 'Требуется вход')
            return self._send_json({'username': sess['username'], 'role': sess['role'], 'csrf': sess['csrf']})

        if path == '/api/folders':
            if not sess:
                return self._err(401, 'Требуется вход')
            with _db_lock, db() as c:
                rows = c.execute('''SELECT fo.id, fo.name, COUNT(f.id) n
                                    FROM folders fo LEFT JOIN files f ON f.folder_id = fo.id
                                    GROUP BY fo.id ORDER BY fo.name''').fetchall()
                root_n = c.execute('SELECT COUNT(*) n FROM files WHERE folder_id IS NULL').fetchone()['n']
            return self._send_json({
                'folders': [{'id': r['id'], 'name': r['name'], 'count': r['n']} for r in rows],
                'rootCount': root_n,
                'role': sess['role'],
            })

        if path == '/api/files':
            if not sess:
                return self._err(401, 'Требуется вход')
            qs = parse_qs(parsed.query)
            folder = (qs.get('folder') or ['all'])[0]
            mine = (qs.get('mine') or [''])[0] == '1'
            q = (qs.get('q') or [''])[0].strip()
            try:
                page = max(1, int((qs.get('page') or ['1'])[0]))
            except ValueError:
                page = 1
            where, args = [], []
            if folder == 'root':
                where.append('f.folder_id IS NULL')
            elif folder not in ('', 'all'):
                where.append('f.folder_id=?')
                args.append(folder)
            if mine:
                where.append('f.user_id=?')
                args.append(sess['id'])
            sql = FILE_SELECT
            if where:
                sql += ' WHERE ' + ' AND '.join(where)
            sql += ' ORDER BY f.uploaded_at DESC'
            with _db_lock, db() as c:
                rows = c.execute(sql, args).fetchall()
            if q:
                # SQLite NOCASE работает только для ASCII — фильтруем кириллицу в Python
                qf = q.casefold()
                rows = [r for r in rows if qf in r['name'].casefold()]
            total = len(rows)
            start = (page - 1) * PAGE_SIZE
            items = [file_public(r, sess) for r in rows[start:start + PAGE_SIZE]]
            return self._send_json({'files': items, 'total': total, 'page': page,
                                    'hasMore': start + PAGE_SIZE < total})

        m = re.fullmatch(r'/api/files/([\w-]{36})/(download|preview)', path)
        if m:
            if not sess:
                return self._err(401, 'Требуется вход')
            fid, mode = m.group(1), m.group(2)
            with _db_lock, db() as c:
                row = c.execute('SELECT * FROM files WHERE id=?', (fid,)).fetchone()
            if not row:
                return self._err(404, 'Файл не найден')
            fpath = os.path.join(FILES_DIR, fid)
            if not os.path.isfile(fpath):
                return self._err(404, 'Файл отсутствует на диске')
            ext = os.path.splitext(row['name'])[1].lower()
            if mode == 'preview' and ext in FORCE_DOWNLOAD:
                return self._err(415, 'Этот тип файла доступен только для скачивания')
            if mode == 'download':
                audit(sess['username'], 'download', row['name'])
            mime = row['mime'] or MIME.get(ext, 'application/octet-stream')
            dispo = 'inline' if mode == 'preview' else 'attachment'
            self.send_response(200)
            self.send_header('Content-Type', mime if mode == 'preview' else 'application/octet-stream')
            self.send_header('Content-Length', str(os.path.getsize(fpath)))
            self.send_header('Content-Disposition', "%s; filename*=UTF-8''%s" % (dispo, quote(row['name'])))
            self.send_header('X-Content-Type-Options', 'nosniff')
            if mode == 'preview' and ext in PREVIEW_TEXT:
                self.send_header('Content-Security-Policy', "sandbox; default-src 'none'")
            self.send_header('Cache-Control', 'private, no-store')
            self.end_headers()
            try:
                with open(fpath, 'rb') as f:
                    shutil.copyfileobj(f, self.wfile, 256 * 1024)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        if path == '/api/server-info':
            if not sess:
                return self._err(401, 'Требуется вход')
            ips = lan_ips()
            port = self.server.server_address[1]
            return self._send_json({'ips': ips, 'port': port,
                                    'addresses': ['http://%s:%d/' % (ip, port) for ip in ips]})

        # ----- статика -----
        if path == '/':
            if not sess:
                self.send_response(302)
                self.send_header('Location', '/login.html')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            path = '/index.html'
        if not sess and path not in self.PUBLIC_PATHS and not path.startswith('/fonts/'):
            return self._err(401, 'Требуется вход')
        rel = os.path.normpath(unquote(path)).lstrip('/\\')
        full = os.path.abspath(os.path.join(PUBLIC_DIR, rel))
        if not full.startswith(os.path.abspath(PUBLIC_DIR) + os.sep) or not os.path.isfile(full):
            return self._err(404, 'Не найдено')
        ext = os.path.splitext(full)[1].lower()
        self.send_response(200)
        self.send_header('Content-Type', MIME.get(ext, 'application/octet-stream'))
        self.send_header('Content-Length', str(os.path.getsize(full)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        try:
            with open(full, 'rb') as f:
                shutil.copyfileobj(f, self.wfile, 256 * 1024)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ================= DELETE =================
    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        sess = self._session()
        if not sess:
            return self._err(401, 'Требуется вход')
        if not self._check_csrf(sess):
            return self._err(403, 'CSRF-проверка не пройдена')

        m = re.fullmatch(r'/api/files/([\w-]{36})', path)
        if m:
            fid = m.group(1)
            with _db_lock, db() as c:
                row = c.execute('SELECT * FROM files WHERE id=?', (fid,)).fetchone()
                if not row:
                    return self._err(404, 'Файл не найден')
                if sess['role'] != 'admin' and row['user_id'] != sess['id']:
                    audit(sess['username'], 'delete-denied', row['name'])
                    return self._err(403, 'Удалять файл может только владелец или администратор')
                try:
                    os.unlink(os.path.join(FILES_DIR, fid))
                except OSError:
                    pass
                c.execute('DELETE FROM files WHERE id=?', (fid,))
            audit(sess['username'], 'delete', row['name'])
            return self._send_json({'ok': True})

        m = re.fullmatch(r'/api/folders/([\w-]{36})', path)
        if m:
            if sess['role'] != 'admin':
                return self._err(403, 'Удалять папки может только администратор')
            fid = m.group(1)
            with _db_lock, db() as c:
                row = c.execute('SELECT * FROM folders WHERE id=?', (fid,)).fetchone()
                if not row:
                    return self._err(404, 'Папка не найдена')
                c.execute('UPDATE files SET folder_id=NULL WHERE folder_id=?', (fid,))
 

                c.execute('DELETE FROM folders WHERE id=?', (fid,))
            audit(sess['username'], 'folder-delete', row['name'])
            return self._send_json({'ok': True, 'movedToRoot': True})

        return self._err(404, 'Не найдено')


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        pass  # обрывы соединений — не спамим консоль


def main():
    port = 7100
    cli_pw = None
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == '--port' and i + 1 < len(args):
            port = int(args[i + 1]); i += 2
        elif args[i] == '--password' and i + 1 < len(args):
            cli_pw = args[i + 1]; i += 2
        else:
            i += 1
    port = int(os.environ.get('OBMEN_PORT', port))

    init_password(cli_pw)
    init_db()
    migrate_legacy()
    retention_sweep()
    threading.Thread(target=sweeper_loop, daemon=True).start()

    srv = QuietServer(('0.0.0.0', port), Handler)
    ips = lan_ips()
    print('=' * 56)
    print('  Обмен — локальный файлообменник офиса  v2.0')
    print('=' * 56)
    print('  Пароль-приглашение (нужен при регистрации): %s' % PASSWORD)
    print('  Первый зарегистрировавшийся станет администратором.')
    print()
    print('  Откройте на этом компьютере:  http://localhost:%d/' % port)
    for ip in ips:
        print('  Для коллег по сети:           http://%s:%d/' % (ip, port))
    print()
    print('  Не закрывайте это окно, пока обменник нужен коллегам.')
    print('  Для остановки нажмите Ctrl+C или закройте окно.')
    print('=' * 56)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == '__main__':
    main()
