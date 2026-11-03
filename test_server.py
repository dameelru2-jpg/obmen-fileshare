# -*- coding: utf-8 -*-
"""Интеграционные тесты Обмен v2: регистрация, роли, CSRF, папки, файлы, права."""
import json
import http.cookiejar
import urllib.request
import urllib.error
import urllib.parse
import sys

def qu(s):
    return urllib.parse.quote(s)

BASE = 'http://127.0.0.1:7391'
INVITE = 'testpw123'
passed = failed = 0

def check(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print('  OK  ' + name)
    else:
        failed += 1
        print('FAIL  ' + name + ('  -> ' + str(detail) if detail else ''))

class Client:
    def __init__(self):
        self.cj = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cj))
        self.csrf = None
    def req(self, method, path, data=None, raw=None, headers=None, csrf=True):
        url = BASE + path
        h = dict(headers or {})
        body = None
        if raw is not None:
            body = raw
        elif data is not None:
            body = json.dumps(data, ensure_ascii=False).encode('utf-8')
            h['Content-Type'] = 'application/json; charset=utf-8'
        if csrf and self.csrf:
            h['X-CSRF-Token'] = self.csrf
        r = urllib.request.Request(url, data=body, headers=h, method=method)
        try:
            resp = self.opener.open(r, timeout=15)
            return resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), dict(e.headers)
    def jreq(self, method, path, **kw):
        st, body, hdrs = self.req(method, path, **kw)
        try:
            return st, json.loads(body.decode('utf-8')), hdrs
        except Exception:
            return st, {}, hdrs

print('== Регистрация и вход ==')
alice = Client()
st, d, _ = alice.jreq('POST', '/api/register', data={'username': 'Алиса', 'password': 'secret1', 'invite': 'wrong'})
check('неверный invite -> 403', st == 403, st)
st, d, _ = alice.jreq('POST', '/api/register', data={'username': 'А', 'password': 'secret1', 'invite': INVITE})
check('ник из 1 символа -> 400', st == 400, st)
st, d, _ = alice.jreq('POST', '/api/register', data={'username': 'Алиса', 'password': '123', 'invite': INVITE})
check('короткий пароль -> 400', st == 400, st)
st, d, _ = alice.jreq('POST', '/api/register', data={'username': 'Алиса', 'password': 'secret1', 'invite': INVITE})
check('Алиса регистрируется', st == 200 and d.get('ok'), (st, d))
check('Алиса = первый пользователь = admin', d.get('role') == 'admin', d.get('role'))
alice.csrf = d.get('csrf')

st, d, _ = alice.jreq('POST', '/api/register', data={'username': 'алиса', 'password': 'secret1', 'invite': INVITE})
check('дубль ника (другой регистр) -> 409', st == 409, st)

st, d, _ = alice.jreq('GET', '/api/me')
check('/api/me возвращает сессию', st == 200 and d.get('username') == 'Алиса', (st, d))

bob = Client()
st, d, _ = bob.jreq('POST', '/api/register', data={'username': 'Борис', 'password': 'secret2', 'invite': INVITE})
check('Борис регистрируется как user', st == 200 and d.get('role') == 'user', (st, d))
bob.csrf = d.get('csrf')

st, d, _ = bob.jreq('POST', '/api/login', data={'username': 'Борис', 'password': 'WRONG'})
check('неверный пароль при входе -> 401', st == 401, st)
st, d, _ = bob.jreq('POST', '/api/login', data={'username': 'Борис', 'password': 'secret2'})
check('вход Бориса', st == 200 and d.get('ok'), (st, d))
bob.csrf = d.get('csrf')

print('== Папки ==')
st, d, _ = bob.jreq('POST', '/api/folders', data={'name': 'Хакерская папка'})
check('обычный юзер не создаёт папки -> 403', st == 403, st)
st, d, _ = bob.jreq('POST', '/api/folders', data={'name': 'Хакерская папка'}, csrf=False)
check('создание папки без CSRF -> 403', st == 403, st)
st, d, _ = alice.jreq('POST', '/api/folders', data={'name': 'Договоры 2026'})
check('admin создаёт папку', st == 201, (st, d))
folder_id = d.get('id')
st, d, _ = alice.jreq('GET', '/api/folders')
names = [f['name'] for f in d.get('folders', [])]
check('стартовые 6 папок + новая', all(n in names for n in ['Кадры', 'Отпуск', 'Больничный', 'Расчёт зарплаты', 'НДФЛ', 'Другие', 'Договоры 2026']), names)

print('== Загрузка и права ==')
content_a = 'Секретный документ Алисы'.encode('utf-8')
st, d, _ = alice.jreq('PUT', '/api/upload?folder=%s&name=%s' % (folder_id, qu('Документ Алисы.txt')),
                      raw=content_a, headers={'Content-Type': 'application/octet-stream'})
check('Алиса загружает файл в папку', st == 201, (st, d))
file_a = d[0]['id'] if isinstance(d, list) and d else None

st, d, _ = alice.jreq('PUT', '/api/upload?folder=root&name=%s' % qu('Корневой.txt'),
                      raw=b'root file', headers={'Content-Type': 'application/octet-stream'})
check('загрузка в корень', st == 201, (st, d))
file_root = d[0]['id'] if isinstance(d, list) and d else None

st, d, _ = bob.jreq('PUT', '/api/upload?folder=%s&name=%s' % (folder_id, qu('Файл Бориса.txt')),
                    raw='документ бориса'.encode('utf-8'), headers={'Content-Type': 'application/octet-stream'})
check('Борис загружает файл', st == 201, (st, d))
file_b = d[0]['id'] if isinstance(d, list) and d else None

st, d, _ = alice.jreq('GET', '/api/files?folder=%s' % folder_id)
check('Алиса видит оба файла в папке', st == 200 and len(d.get('files', [])) == 2, d.get('total'))
st, d, _ = bob.jreq('GET', '/api/files?folder=%s&mine=1' % folder_id)
check('«Мои файлы» Бориса = только его', st == 200 and len(d.get('files', [])) == 1 and d['files'][0]['uploader'] == 'Борис', d)

print('== Ключевая уязвимость: подмена ника ==')
st, d, _ = bob.jreq('DELETE', '/api/files/%s' % file_a)
check('Борис НЕ может удалить файл Алисы -> 403', st == 403, st)
eve = Client()
st, d, _ = eve.jreq('POST', '/api/register', data={'username': 'Алиса', 'password': 'secret3', 'invite': INVITE})
check('занятый ник при регистрации -> 409 (подмена невозможна)', st == 409, st)

print('== Предпросмотр и скачивание ==')
st, body, hdrs = bob.req('GET', '/api/files/%s/preview' % file_a)
check('превью txt: inline + nosniff', st == 200 and 'inline' in hdrs.get('Content-Disposition', '') and hdrs.get('X-Content-Type-Options') == 'nosniff', (st, hdrs.get('Content-Disposition')))
st, body, hdrs = bob.req('GET', '/api/files/%s/download' % file_a)
check('скачивание: attachment + содержимое совпадает', st == 200 and body == content_a and 'attachment' in hdrs.get('Content-Disposition', ''), st)
st, d, _ = bob.jreq('PUT', '/api/upload?folder=root&name=evil.html', raw=b'<script>alert(1)</script>',
                    headers={'Content-Type': 'application/octet-stream'})
evil_id = d[0]['id'] if isinstance(d, list) and d else None
st, body, hdrs = bob.req('GET', '/api/files/%s/preview' % evil_id)
check('html в превью запрещён -> 415', st == 415, st)
st, body, hdrs = bob.req('GET', '/api/files/%s/download' % evil_id)
check('html скачивается как attachment', st == 200 and 'attachment' in hdrs.get('Content-Disposition', ''), st)

print('== Поиск и пагинация ==')
st, d, _ = bob.jreq('GET', '/api/files?q=%s' % qu('алис'))
check('поиск «алис» находит файл Алисы', st == 200 and any('Алисы' in f['name'] for f in d.get('files', [])), d)
st, d, _ = bob.jreq('GET', '/api/files?q=%s' % qu('несуществующийxyz'))
check('поиск без совпадений -> 0', st == 200 and d.get('total') == 0, d)
for i in range(25):
    bob.jreq('PUT', '/api/upload?folder=root&name=%s' % qu('массовый %02d.txt' % i), raw=b'x', headers={'Content-Type': 'application/octet-stream'})
st, d, _ = bob.jreq('GET', '/api/files?page=1')
check('пагинация: стр.1 = 20, hasMore=true', len(d.get('files', [])) == 20 and d.get('hasMore'), (len(d.get('files', [])), d.get('hasMore')))
st, d, _ = bob.jreq('GET', '/api/files?page=2')
check('пагинация: стр.2 = остаток', st == 200 and 0 < len(d.get('files', [])) <= 20, len(d.get('files', [])))

print('== Удаление ==')
st, d, _ = alice.jreq('DELETE', '/api/files/%s' % file_b)
check('admin удаляет чужой файл', st == 200, st)
st, d, _ = bob.jreq('POST', '/api/files/bulk-delete', data={'ids': [file_root, file_a]})
check('bulk: Борис удаляет 0 (оба чужих), denied=2', st == 200 and d.get('deleted') == 0 and d.get('denied') == 2, d)
my_ids = [f['id'] for f in bob.jreq('GET', '/api/files?mine=1&q=%s' % qu('массовый'))[1].get('files', [])]
st, d, _ = bob.jreq('POST', '/api/files/bulk-delete', data={'ids': my_ids})
check('bulk: Борис удаляет свои 20', st == 200 and d.get('deleted') == 20, d)

print('== Папки: удаление ==')
st, d, _ = bob.jreq('DELETE', '/api/folders/%s' % folder_id)
check('юзер не удаляет папку -> 403', st == 403, st)
st, d, _ = alice.jreq('DELETE', '/api/folders/%s' % folder_id)
check('admin удаляет папку, файлы -> корень', st == 200 and d.get('movedToRoot'), d)
st, d, _ = alice.jreq('GET', '/api/files?folder=root')
check('файл Алисы теперь в корне', st == 200 and any(f['id'] == file_a for f in d.get('files', [])), d.get('total'))

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):
        return None

print('== Гость ==')
guest = Client()
guest.opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(guest.cj), NoRedirect())
st, d, _ = guest.jreq('GET', '/api/files')
check('гость: /api/files -> 401', st == 401, st)
st, body, hdrs = guest.req('GET', '/')
check('гость: / -> редирект на login', st in (301, 302, 303, 307, 308), st)
st, body, hdrs = guest.req('GET', '/app.js')
check('гость: /app.js -> 401', st == 401, st)
st, body, hdrs = guest.req('GET', '/login.html')
check('гость: /login.html доступен', st == 200, st)
st, body, hdrs = guest.req('GET', '/../server.py')
check('path traversal заблокирован', st in (401, 404), st)

print('== Выход ==')
st, d, _ = alice.jreq('POST', '/api/logout')
check('logout', st == 200, st)
st, d, _ = alice.jreq('GET', '/api/me')
check('после logout сессия мертва -> 401', st == 401, st)

print()
print('ИТОГ: passed=%d failed=%d' % (passed, failed))
sys.exit(1 if failed else 0)
