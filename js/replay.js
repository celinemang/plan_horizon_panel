/* Scene replay: a horizontal timeline under the Unity view that rewinds what the robot did.
   The Unity canvas (same-origin iframe) is recorded IN THE BROWSER while the robot moves: canvas.captureStream()
   -> hidden <video> -> small JPEG frames kept in memory. Nothing is uploaded and Unity is never rewound itself
   (its state stays where the robot really is), so the replay can only show what the participant already saw.
   Usage: var r = SceneReplay.create(area, bar, onEvent); r.attach(iframe, '#unity-canvas'); r.recording(true|false);
          r.mark(label); r.reset(); */
(function () {
  'use strict';
  var FPS = 6, MAX_FRAMES = 4000, WIDTH = 520, QUALITY = 0.72;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clock(frames, fps) {
    var s = Math.round(frames / fps);
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  function create(area, bar, onEvent) {
    var frames = [], marks = [], fps = FPS, keepEvery = 1, tick = 0;
    var rec = false, live = true, playing = false, pos = 0;
    var video = null, work = document.createElement('canvas'), ctx = work.getContext('2d');
    var timer = null, playTimer = null, shownUrl = null, scrubbing = false;
    var log = typeof onEvent === 'function' ? onEvent : function () {};

    // ---- bar ----
    bar.textContent = '';
    bar.hidden = false;
    var playBtn = el('button', 'replay-play'); playBtn.type = 'button';
    var track = el('div', 'replay-track');
    var ticks = el('div', 'replay-ticks');
    var range = el('input', 'replay-range');
    range.type = 'range'; range.min = '0'; range.max = '0'; range.step = '1'; range.value = '0';
    range.setAttribute('aria-label', 'Rewind the robot');
    track.appendChild(ticks); track.appendChild(range);
    var time = el('span', 'replay-time', '0:00');
    var liveBtn = el('button', 'replay-live', 'Live'); liveBtn.type = 'button';
    liveBtn.title = 'Back to the robot now';
    bar.appendChild(playBtn); bar.appendChild(track); bar.appendChild(time); bar.appendChild(liveBtn);

    // ---- overlay on the scene ----
    var view = el('div', 'replay-view'); view.hidden = true;
    var img = el('img'); img.alt = 'Replay of what the robot did';
    var badge = el('span', 'replay-badge');
    view.appendChild(img); view.appendChild(badge);
    area.appendChild(view);

    function stepAt(i) {   // last mark at or before frame i
      var m = null;
      marks.forEach(function (k) { if (k.frame <= i) m = k; });
      return m;
    }

    function show(i) {
      var f = frames[i];
      if (!f || !f.blob) return;
      if (shownUrl) URL.revokeObjectURL(shownUrl);
      shownUrl = URL.createObjectURL(f.blob);
      img.src = shownUrl;
      var m = stepAt(i);
      badge.textContent = 'Replay ' + clock(i, fps) + (m ? ' · after: ' + m.label : '');
    }

    function update() {
      var n = frames.length;
      range.max = String(Math.max(0, n - 1));
      if (live) pos = Math.max(0, n - 1);
      if (!scrubbing) range.value = String(pos);
      range.disabled = n < 2;
      playBtn.disabled = n < 2;
      time.textContent = live ? clock(n, fps) : clock(pos, fps) + ' / ' + clock(n, fps);
      liveBtn.disabled = live;
      bar.classList.toggle('is-live', live);
      bar.classList.toggle('is-rec', rec && live);
      playBtn.textContent = playing ? '❚❚' : '▶';
      playBtn.setAttribute('aria-label', playing ? 'Pause replay' : 'Play replay');
      view.hidden = live;
      area.classList.toggle('replaying', !live);
      Array.prototype.forEach.call(ticks.children, function (t, k) {
        var m = marks[k];
        t.style.left = (n > 1 ? 100 * Math.min(m.frame, n - 1) / (n - 1) : 0) + '%';
      });
    }

    function goLive(reason) {
      stopPlay();
      if (live) return;
      live = true;
      if (shownUrl) { URL.revokeObjectURL(shownUrl); shownUrl = null; img.removeAttribute('src'); }
      log('replay_live', { reason: reason, frames: frames.length });
      update();
    }

    function seek(i, how) {
      var n = frames.length;
      if (n < 2) return;
      i = Math.max(0, Math.min(n - 1, i | 0));
      if (live) log('replay_open', { how: how, frames: n });
      live = false;
      pos = i;
      show(pos);
      update();
    }

    function stopPlay() {
      playing = false;
      clearInterval(playTimer); playTimer = null;
    }

    function play() {
      if (frames.length < 2) return;
      if (live || pos >= frames.length - 1) seek(0, 'play');
      playing = true;
      log('replay_play', { from_frame: pos, frames: frames.length });
      clearInterval(playTimer);
      playTimer = setInterval(function () {
        if (pos >= frames.length - 1) { goLive('play_end'); return; }
        pos++;
        show(pos);
        update();
      }, 1000 / fps);
      update();
    }

    playBtn.addEventListener('click', function () { if (playing) { stopPlay(); log('replay_pause', { frame: pos }); update(); } else play(); });
    liveBtn.addEventListener('click', function () { goLive('button'); });
    range.addEventListener('input', function () { scrubbing = true; stopPlay(); seek(+range.value, 'drag'); });
    range.addEventListener('change', function () {
      scrubbing = false;
      if (+range.value >= frames.length - 1) goLive('drag_end');
      else log('replay_seek', { frame: pos, frames: frames.length });
      update();
    });

    // ---- recording ----
    function capture() {
      if (!rec || !video || video.readyState < 2 || !video.videoWidth) return;
      if ((tick++ % keepEvery) !== 0) return;
      var w = Math.min(WIDTH, video.videoWidth), h = Math.round(w * video.videoHeight / video.videoWidth);
      if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
      ctx.drawImage(video, 0, 0, w, h);
      var slot = { blob: null };
      frames.push(slot);
      work.toBlob(function (b) { slot.blob = b; }, 'image/jpeg', QUALITY);
      if (frames.length > MAX_FRAMES) thin();
      update();
    }

    // too long: keep every other frame and record at half the rate from now on (marks keep their place)
    function thin() {
      frames = frames.filter(function (f, k) { return k % 2 === 0; });
      marks.forEach(function (m) { m.frame = Math.floor(m.frame / 2); });
      pos = Math.floor(pos / 2);
      keepEvery *= 2; fps = FPS / keepEvery;
    }

    function attach(frame, selector) {
      function hook() {
        var doc, canvas;
        try { doc = frame.contentDocument; canvas = doc && doc.querySelector(selector); } catch (err) { return false; }
        if (!canvas || typeof canvas.captureStream !== 'function') return false;
        var stream = canvas.captureStream(FPS);
        video = document.createElement('video');
        video.muted = true; video.playsInline = true; video.srcObject = stream;
        var p = video.play(); if (p && p.catch) p.catch(function () {});
        return true;
      }
      var tries = 0;
      (function wait() {
        if (hook()) return;
        if (++tries < 120) setTimeout(wait, 500);
        else bar.hidden = true;   // canvas not reachable (e.g. cross-origin Unity): no replay, no empty bar
      })();
      clearInterval(timer);
      timer = setInterval(capture, 1000 / FPS);
    }

    return {
      attach: attach,
      recording: function (on) { rec = !!on; if (on) goLive('robot_moves'); update(); },
      // a finished robot step: a tick on the bar at the current end of the recording
      mark: function (label, kind) {
        var m = { frame: Math.max(0, frames.length - 1), label: String(label), kind: kind || 'step' };
        marks.push(m);
        var t = el('button', 'replay-tick ' + m.kind); t.type = 'button';
        t.title = m.label; t.setAttribute('aria-label', 'Rewind to: ' + m.label);
        t.addEventListener('click', function () { stopPlay(); seek(m.frame, 'tick'); log('replay_seek', { frame: m.frame, tick: m.label }); });
        ticks.appendChild(t);
        update();
      },
      isLive: function () { return live; },
      frameCount: function () { return frames.length; }
    };
  }

  window.SceneReplay = { create: create };
})();
