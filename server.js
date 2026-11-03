/**
 * Локальный файлообменник для офисной сети.
 * Запуск: npm run dev  (порт по умолчанию 7100; --port / --host или env PORT / HOST)
 * Коллеги открывают в браузере: http://<IP-этого-компьютера>:<порт>
 */
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'uploads');
const FILES_DIR = path.join(DATA_DIR, 'files');
const META_PATH = path.join(DATA_DIR, 'meta.json');

fs.mkdirSync(FILES_DIR, { recursive: true });
if (!fs.existsSync(META_PATH)) fs.writeFileSync(META_PATH, '[]', 'utf8');

const GROUPS = [
  { id: 'kadry',     label: 'Кадры' },
  { id: 'otpusk',    label: 'Отпуск' },
  { id: 'bolnichny', label: 'Больничный' },
  { id: 'zarplata',  label: 'Расчёт зарплаты' },
  { id: 'ndfl',      label: 'НДФЛ' },
  { id: 'drugie',    label: 'Другие' },
];
const GROUP_IDS = new Set(GROUPS.map(g => g.id));

// ---------- метаданные ----------
function readMeta() {
  try { return JSON.parse(fs.readFileSync(META_PATH, 'utf8')); }
  catch { return []; }
}
function writeMeta(list) {
  const tmp = META_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, META_PATH);
}
function publicFile(f) {
  return {
    id: f.id,
    name: f.name,
    size: f.size,
    group: f.group,
    uploader: f.uploader,
    uploadedAt: f.uploadedAt,
  };
}

// ---------- загрузка ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, FILES_DIR),
  filename: (req, file, cb) => cb(null, crypto.randomUUID()),
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // до 500 МБ
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/groups', (req, res) => {
  const meta = readMeta();
  res.json(GROUPS.map(g => ({
    ...g,
    count: meta.filter(f => f.group === g.id).length,
  })));
});

app.get('/api/files', (req, res) => {
  const group = req.query.group;
  let meta = readMeta();
  if (group && GROUP_IDS.has(group)) meta = meta.filter(f => f.group === group);
  meta.sort((a, b) => b.uploadedAt - a.uploadedAt);
  res.json(meta.map(publicFile));
});

app.post('/api/upload', upload.array('files', 20), (req, res) => {
  const group = req.body.group;
  const uploader = String(req.body.uploader || 'Аноним').slice(0, 60);
  if (!GROUP_IDS.has(group)) {
    for (const f of req.files || []) fs.unlink(f.path, () => {});
    return res.status(400).json({ error: 'Неизвестная группа' });
  }
  const meta = readMeta();
  const added = [];
  for (const f of req.files || []) {
    // multer 2.x отдаёт корректное UTF-8 имя; подстраховка для старых клиентов:
    let name = f.originalname;
    try {
      const fixed = Buffer.from(name, 'latin1').toString('utf8');
      if (!fixed.includes('�')) name = fixed;
    } catch {}
    const rec = {
      id: path.basename(f.path),
      name: name.slice(0, 255),
      size: f.size,
      group,
      uploader,
      uploadedAt: Date.now(),
    };
    meta.push(rec);
    added.push(publicFile(rec));
  }
  writeMeta(meta);
  res.status(201).json(added);
});

// Потоковая загрузка одного файла (PUT, сырые байты) — тот же протокол, что у Python-сервера
app.put('/api/upload', (req, res) => {
  const group = req.query.group;
  const name = (path.basename(String(req.query.name || 'file')) || 'file').slice(0, 255);
  const uploader = String(req.query.uploader || 'Аноним').slice(0, 60);
  if (!GROUP_IDS.has(group)) { req.resume(); return res.status(400).json({ error: 'Неизвестная группа' }); }

  const id = crypto.randomUUID();
  const filePath = path.join(FILES_DIR, id);
  const out = fs.createWriteStream(filePath);
  let size = 0, aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > 500 * 1024 * 1024 && !aborted) { aborted = true; req.destroy(); }
  });
  req.pipe(out);
  out.on('finish', () => {
    if (aborted) {
      out.destroy(); fs.unlink(filePath, () => {});
      return res.status(413).json({ error: 'Файл больше 500 МБ' });
    }
    const rec = { id, name, size, group, uploader, uploadedAt: Date.now() };
    const meta = readMeta(); meta.push(rec); writeMeta(meta);
    res.status(201).json([publicFile(rec)]);
  });
  const fail = () => { out.destroy(); fs.unlink(filePath, () => {}); if (!res.headersSent) res.status(500).json({ error: 'Не удалось сохранить файл' }); };
  out.on('error', fail);
  req.on('error', fail);
});

app.get('/api/files/:id/download', (req, res) => {
  const rec = readMeta().find(f => f.id === req.params.id);
  const filePath = rec && path.join(FILES_DIR, rec.id);
  if (!rec || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл не найден' });
  res.download(filePath, rec.name); // express сам кодирует кириллицу в Content-Disposition
});

app.delete('/api/files/:id', (req, res) => {
  let user = '';
  try { user = decodeURIComponent(req.header('X-User') || ''); } catch { user = req.header('X-User') || ''; }
  const meta = readMeta();
  const rec = meta.find(f => f.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'Файл не найден' });
  if (rec.uploader !== user) return res.status(403).json({ error: 'Удалять может только тот, кто загрузил файл' });
  fs.unlink(path.join(FILES_DIR, rec.id), () => {});
  writeMeta(meta.filter(f => f.id !== rec.id));
  res.json({ ok: true });
});

app.get('/api/server-info', (req, res) => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  res.json({ port: PORT, ips });
});

// ---------- запуск ----------
function argVal(name) {
  const i = process.argv.indexOf('--' + name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find(a => a.startsWith('--' + name + '='));
  return eq ? eq.split('=')[1] : undefined;
}
const PORT = Number(process.env.PORT || argVal('port') || 7100);
const HOST = process.env.HOST || argVal('host') || '0.0.0.0';

app.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  console.log(`\nФайлообменник запущен:`);
  console.log(`  на этом компьютере:  http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  для коллег по сети:  http://${ip}:${PORT}`);
  console.log('');
});
