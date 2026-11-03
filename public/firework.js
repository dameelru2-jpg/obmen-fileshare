/* 8-битный салют при успешной загрузке файла.
   Canvas 2D, квадратные частицы 4px, requestAnimationFrame.
   Оптимизации: prefers-reduced-motion -> пропуск; document.hidden -> пропуск;
   hardwareConcurrency < 4 -> один залп; авто-остановка и освобождение ресурсов. */
(function () {
  'use strict';

  var COLORS = ['#ff4d4d', '#ffd24d', '#4dff88', '#4dc9ff', '#c84dff', '#ff8c4d'];
  var SIZE = 4;               // квадрат 4px — «пиксель»
  var GRAVITY = 0.07;
  var DURATION = 2200;        // мс, жёсткий стоп

  var canvas = null, ctx = null, particles = [], rafId = 0, running = false, startedAt = 0;

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'firework-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
  }

  function resize() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function burst(x, y, count) {
    for (var i = 0; i < count; i++) {
      var angle = (Math.PI * 2 * i) / count + Math.random() * 0.35;
      var speed = 2.2 + Math.random() * 3.4;
      particles.push({
        x: x, y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.2,
        life: 55 + Math.random() * 35,
        age: 0,
        color: COLORS[(Math.random() * COLORS.length) | 0]
      });
    }
  }

  function loop() {
    if (!running) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var now = performance.now();
    var alive = [];
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.age++;
      if (p.age >= p.life) continue;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += GRAVITY;
      p.vx *= 0.985;
      // мерцание в конце жизни — 8-битный эффект
      if (p.age > p.life * 0.7 && (p.age % 4) < 2) { alive.push(p); continue; }
      ctx.fillStyle = p.color;
      ctx.fillRect((p.x / SIZE | 0) * SIZE, (p.y / SIZE | 0) * SIZE, SIZE, SIZE);
      alive.push(p);
    }
    particles = alive;
    if (particles.length === 0 || now - startedAt > DURATION || document.hidden) {
      stop();
      return;
    }
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    particles = [];
    if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  /** Запуск салюта. Безопасен к повторным вызовам. */
  window.obmenFirework = function () {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      if (document.hidden) return;
      var lowPower = (navigator.hardwareConcurrency || 4) < 4;
      var shots = lowPower ? 1 : 3;
      var perBurst = lowPower ? 40 : 60;

      ensureCanvas();
      resize();
      stop();
      running = true;
      startedAt = performance.now();

      var w = canvas.width, h = canvas.height;
      for (var s = 0; s < shots; s++) {
        (function (idx) {
          setTimeout(function () {
            if (!running || document.hidden) return;
            burst(w * (0.25 + 0.5 * Math.random()), h * (0.2 + 0.35 * Math.random()), perBurst);
          }, idx * 260);
        })(s);
      }
      rafId = requestAnimationFrame(loop);
    } catch (e) { /* салют не должен ломать загрузку */ }
  };

  window.addEventListener('resize', function () { if (running) resize(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); });
})();
