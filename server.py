# -*- coding: utf-8 -*-
"""
Обмен — локальный файлообменник офиса. Однофайловый сервер на стандартной
библиотеке Python (без зависимостей). Собирается в один .exe через PyInstaller.

Запуск:  Обмен.exe [--port 7100] [--host 0.0.0.0]
Коллеги открывают в браузере адрес, который сервер печатает при старте.
"""
import json
import os
import re
import shutil
import sys
import threading
import time
import socket
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote, quote

# --- пути: рядом с exe (frozen) или рядом со скриптом ---
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
    PUBLIC_DIR = os.path.join(sys._MEIPASS, 'public')
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    PUBLIC_DIR = os.path.join(BASE_DIR, 'public')

DATA_DIR = os.path.join(BASE_DIR, 'uploads')
FILES_DIR = os.path.join(DATA_DIR, 'files')
META_PATH = os.path.join(DATA_DIR, 'meta.json')

os.makedirs(FILES_DIR, exist_ok=True)
if not os.path.exists(META_PATH):
    with open(META_PATH, 'w', encoding='utf-8') as f:
        f.write('[]')

GROUPS = [
    {'id': 'kadry',     'label': 'Кадры'},
    {'id': 'otpusk',    'label': 'Отпуск'},
    {'id': 'bolnichny', 'label': 'Больничный'},
    {'id': 'zarplata',  'label': 'Расчёт зарплаты'},
    {'id': 'ndfl',      'label': 'НДФЛ'},
    {'id': 'drugie',    'label': 'Другие'},
]
GROUP_IDS = {g['id'] for g in GROUPS}
MAX_UPLOAD = 500 * 1024 * 1024  # 500 МБ

MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
    '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
}

_meta_lock = threading.Lock()

def read_meta():
    with _meta_lock:
        try:
            with open(META_PATH, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return []

def write_meta(items):
    with _meta_lock:
        tmp = META_PATH + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
        os.replace(tmp, META_PATH)

def public_file(rec):
    return {k: rec[k] for k in ('id', 'name', 'size', 'group', 'uploader', 'uploadedAt')}

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


class Handler(BaseHTTPRequestHandler):
    server_version = 'ObmenFileshare/1.0'
    protocol_version = 'HTTP/1.1'

    # --- helpers ---
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, status, msg):
        self._send_json({'error': msg}, status)

    def log_message(self, fmt, *args):  # тихий сервер
        pass

    # --- GET ---
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == '/api/groups':
            meta = read_meta()
            out = [dict(g, count=sum(1 for f in meta if f['group'] == g['id'])) for g in GROUPS]
            return self._send_json(out)

        if path == '/api/files':
            group = (qs.get('group') or [''])[0]
            meta = read_meta()
            if group in GROUP_IDS:
                meta = [f for f in meta if f['group'] == group]
            meta.sort(key=lambda f: -f['uploadedAt'])
            return self._send_json([public_file(f) for f in meta])

        if path == '/api/server-info':
            return self._send_json({'port': self.server.server_port, 'ips': lan_ips()})

        m = re.fullmatch(r'/api/files/([0-9a-f-]{36})/download', path)
        if m:
            rec = next((f for f in read_meta() if f['id'] == m.group(1)), None)
            fpath = rec and os.path.join(FILES_DIR, rec['id'])
            if not rec or not os.path.exists(fpath):
                return self._send_error_json(404, 'Файл не найден')
            name_ascii = re.sub(r'[^\x20-\x7e]', '?', rec['name'])
            cd = "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (name_ascii, quote(rec['name']))
            size = os.path.getsize(fpath)
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Disposition', cd)
            self.send_header('Content-Length', str(size))
            self.end_headers()
            with open(fpath, 'rb') as f:
                shutil.copyfileobj(f, self.wfile, 256 * 1024)
            return

        # статика
        if path == '/':
            path = '/index.html'
        safe = os.path.normpath(unquote(path)).lstrip('\\/')
        full = os.path.join(PUBLIC_DIR, safe)
        if not os.path.abspath(full).startswith(os.path.abspath(PUBLIC_DIR)) or not os.path.isfile(full):
            return self._send_error_json(404, 'Не найдено')
        ext = os.path.splitext(full)[1].lower()
        size = os.path.getsize(full)
        self.send_response(200)
        self.send_header('Content-Type', MIME.get(ext, 'application/octet-stream'))
        self.send_header('Content-Length', str(size))
        self.end_headers()
        with open(full, 'rb') as f:
            shutil.copyfileobj(f, self.wfile, 256 * 1024)

    # --- PUT /api/upload?group=..&name=..&uploader=..  (сырые байты файла) ---
    def do_PUT(self):
        parsed = urlparse(self.path)
        if parsed.path != '/api/upload':
            return self._send_error_json(404, 'Не найдено')
        qs = parse_qs(parsed.query)
        group = (qs.get('group') or [''])[0]
        name = (os.path.basename((qs.get('name') or ['file'])[0]) or 'file')[:255]
        uploader = (qs.get('uploader') or ['Аноним'])[0][:60]
        if group not in GROUP_IDS:
            self.close_connection = True  # тело не читаем — соединение закрываем
            return self._send_error_json(400, 'Неизвестная группа')

        length_hdr = self.headers.get('Content-Length')
        if length_hdr is None:
            self.close_connection = True
            return self._send_error_json(400, 'Нет тела запроса')
        length = int(length_hdr)
        if length > MAX_UPLOAD:
            self.close_connection = True
            return self._send_error_json(413, 'Файл больше 500 МБ')

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
                return self._send_error_json(400, 'Загрузка оборвалась')
        except Exception:
            try: os.unlink(fpath)
            except OSError: pass
            return self._send_error_json(500, 'Не удалось сохранить файл')

        rec = {
            'id': fid, 'name': name, 'size': length, 'group': group,
            'uploader': uploader, 'uploadedAt': int(time.time() * 1000),
        }
        meta = read_meta()
        meta.append(rec)
        write_meta(meta)
        self._send_json([public_file(rec)], 201)

    # --- DELETE /api/files/<id> ---
    def do_DELETE(self):
        m = re.fullmatch(r'/api/files/([0-9a-f-]{36})', urlparse(self.path).path)
        if not m:
            return self._send_error_json(404, 'Не найдено')
        user = unquote(self.headers.get('X-User') or '')
        meta = read_meta()
        rec = next((f for f in meta if f['id'] == m.group(1)), None)
        if not rec:
            return self._send_error_json(404, 'Файл не найден')
        if rec['uploader'] != user:
            return self._send_error_json(403, 'Удалять может только тот, кто загрузил файл')
        try: os.unlink(os.path.join(FILES_DIR, rec['id']))
        except OSError: pass
        write_meta([f for f in meta if f['id'] != rec['id']])
        self._send_json({'ok': True})


def main():
    class QuietServer(ThreadingHTTPServer):
        daemon_threads = True
        def handle_error(self, request, client_address):
            pass  # обрывы соединений — норма, не засоряем консоль

    args = sys.argv[1:]
    def arg(name):
        if ('--' + name) in args:
            i = args.index('--' + name)
            return args[i + 1] if i + 1 < len(args) else None
        for a in args:
            if a.startswith('--' + name + '='):
                return a.split('=', 1)[1]
        return None
    port = int(os.environ.get('PORT') or arg('port') or 7100)
    host = os.environ.get('HOST') or arg('host') or '0.0.0.0'

    server = QuietServer((host, port), Handler)
    server.daemon_threads = True
    print()
    print('Файлообменник запущен:')
    print('  на этом компьютере:  http://localhost:%d' % port)
    for ip in lan_ips():
        print('  для коллег по сети:  http://%s:%d' % (ip, port))
    print()
    print('Окно можно свернуть. Чтобы остановить — закройте окно или нажмите Ctrl+C.')
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
