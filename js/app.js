(function () {
  'use strict';

  var DEFAULT_N = 3, MIN_N = 2, MAX_N = 4;
  var PLACEHOLDER = 'Select...';

  var vocab, config;
  var verbsById = {};
  var entities;      // {locations:[], objects:[], devices:[]}
  var slots = [];    // {verb, params: {name: value}} — 카드를 추가한 만큼만 존재
  var maxSteps = DEFAULT_N;   // 체크포인트의 n = 추가할 수 있는 최대 카드 수

  var metrics, t0, submitted;
  var trial = { trial_id: null, checkpoint_id: null };
  var pendingMessages = [];   // config 로딩 전에 도착한 메시지
  var ready = false;

  // 새 트라이얼 시작: 슬롯과 지표를 초기화 (Step 5에서 checkpoint 수신 시 재사용)
  function startTrial(n) {
    slots = [];
    maxSteps = n;
    metrics = {
      opened_at: new Date().toISOString(),
      first_drag_ms: null,
      total_ms: null,
      move_count: 0,
      delete_count: 0,
      param_change_count: 0
    };
    t0 = performance.now();
    submitted = false;
  }

  function markFirstDrag() {
    if (metrics.first_drag_ms === null) metrics.first_drag_ms = Math.round(performance.now() - t0);
  }

  function buildResponse() {
    return slots.map(function (item, i) {
      if (!item) return { slot: i, verb: null, params: {} };
      var params = {};
      verbsById[item.verb].params.forEach(function (p) {
        params[p.name] = item.params[p.name] || null;
      });
      return { slot: i, verb: item.verb, params: params };
    });
  }

  function submit() {
    if (submitted) return;
    submitted = true;
    metrics.total_ms = Math.round(performance.now() - t0);
    var response = buildResponse();
    render();   // 제출 후 잠금 상태 반영 (Submit 비활성화, Toolbox 흐리게)
    if (config.devMode && new URLSearchParams(location.search).get('debug') === '1') {
      var pre = document.getElementById('debug-out');
      if (!pre) {
        pre = document.createElement('pre');
        pre.id = 'debug-out';
        document.getElementById('main').appendChild(pre);
      }
      pre.textContent = JSON.stringify({ response: response, metrics: metrics }, null, 2);
    }
    sendToParent({
      type: 'response_submitted',
      trial_id: trial.trial_id,
      checkpoint_id: trial.checkpoint_id,
      response: response,
      metrics: metrics
    });
  }

  // targetOrigin은 config에서만 읽는다. "*"는 devMode에서만 허용.
  function sendToParent(msg) {
    var target = config.targetOrigin;
    if (!target || (target === '*' && !config.devMode)) {
      console.error('postMessage not sent: invalid targetOrigin');
      return;
    }
    if (window.parent === window) {
      console.log('no parent window; message not sent', JSON.stringify(msg));
      return;
    }
    window.parent.postMessage(msg, target);
  }

  function isStringArray(a) {
    return Array.isArray(a) && a.every(function (x) { return typeof x === 'string'; });
  }

  function validCheckpoint(m) {
    var ent = m.entities;
    return Number.isInteger(m.n) && m.n >= MIN_N && m.n <= MAX_N &&
      ent && typeof ent === 'object' &&
      isStringArray(ent.locations) && isStringArray(ent.objects) && isStringArray(ent.devices);
  }

  function startCheckpoint(m) {
    trial.trial_id = m.trial_id;
    trial.checkpoint_id = m.checkpoint_id;
    entities = {
      locations: m.entities.locations,
      objects: m.entities.objects,
      devices: m.entities.devices
    };
    startTrial(m.n);
    var dbg = document.getElementById('debug-out');
    if (dbg) dbg.remove();
    render();
    document.getElementById('panel').hidden = false;
  }

  function handleMessage(event) {
    if (config.allowedOrigins.indexOf(event.origin) === -1) return;
    if (event.source !== window.parent) return;
    var m = event.data;
    if (!m || typeof m !== 'object' || m.type !== 'checkpoint') return;
    if (!validCheckpoint(m)) {
      console.warn('invalid checkpoint message ignored');
      return;
    }
    startCheckpoint(m);
  }

  // 리스너는 즉시 등록하고, config 로딩 전 메시지는 보관했다가 처리
  window.addEventListener('message', function (event) {
    if (ready) handleMessage(event);
    else pendingMessages.push(event);
  });

  function getN() {
    var raw = new URLSearchParams(location.search).get('n');
    var n = parseInt(raw, 10);
    return n >= MIN_N && n <= MAX_N ? n : DEFAULT_N;
  }

  // 풀을 합치고 중복 제거 후 알파벳순 고정 (순서가 단서가 되지 않도록)
  function optionsFor(param) {
    var seen = {}, out = [];
    param.pools.forEach(function (pool) {
      (entities[pool] || []).forEach(function (e) {
        if (!seen[e]) { seen[e] = true; out.push(e); }
      });
    });
    return out.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
  }

  function renderToolbox() {
    var box = document.getElementById('toolbox-cards');
    vocab.verbs.forEach(function (verb) {
      var card = document.createElement('div');
      card.className = 'card';
      card.draggable = true;
      card.dataset.verb = verb.id;
      card.textContent = verb.label;
      card.addEventListener('dragstart', function (e) {
        markFirstDrag();
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', JSON.stringify({ from: 'toolbox', verb: verb.id }));
      });
      card.addEventListener('click', function () { addCard(verb.id); });
      box.appendChild(card);
    });
  }

  function buildSlotCard(index) {
    var item = slots[index];
    var verb = verbsById[item.verb];
    var card = document.createElement('div');
    card.className = 'card slot-card';
    card.draggable = true;
    card.addEventListener('dragstart', function (e) {
      markFirstDrag();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify({ from: 'slot', index: index }));
    });

    var head = document.createElement('div');
    head.className = 'card-head';
    var title = document.createElement('span');
    title.textContent = verb.label;
    var rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'remove-btn';
    rm.textContent = '×';
    rm.setAttribute('aria-label', 'Remove');
    rm.addEventListener('click', function () {
      if (submitted) return;
      metrics.delete_count++;
      slots.splice(index, 1);
      render();
    });
    head.appendChild(title);
    head.appendChild(rm);
    card.appendChild(head);

    verb.params.forEach(function (param) {
      var wrap = document.createElement('label');
      wrap.className = 'param';
      var cap = document.createElement('span');
      cap.textContent = param.label;
      var sel = document.createElement('select');
      var ph = document.createElement('option');
      ph.value = '';
      ph.textContent = PLACEHOLDER;
      sel.appendChild(ph);
      optionsFor(param).forEach(function (e) {
        var o = document.createElement('option');
        o.value = e;
        o.textContent = e;
        sel.appendChild(o);
      });
      sel.value = item.params[param.name] || '';
      sel.addEventListener('change', function () {
        if (submitted) { sel.value = item.params[param.name] || ''; return; }
        metrics.param_change_count++;
        item.params[param.name] = sel.value;
        updateSubmit();
      });
      wrap.appendChild(cap);
      wrap.appendChild(sel);
      card.appendChild(wrap);
    });
    return card;
  }

  function isFull() { return slots.length >= maxSteps; }

  // Toolbox 카드를 클릭하거나 타임라인 빈 곳에 놓으면 맨 뒤에 슬롯이 하나 늘어난다
  function addCard(verbId) {
    if (submitted || isFull() || !verbsById[verbId]) return;
    markFirstDrag();
    slots.push(newItem(verbId));
    render();
  }

  function readDrag(e) {
    try { return JSON.parse(e.dataTransfer.getData('text/plain')); } catch (err) { return null; }
  }

  // 슬롯 위에 놓기: Toolbox 카드는 교체, 슬롯 카드는 맞바꿈
  function onDrop(targetIndex, e) {
    e.preventDefault();
    e.stopPropagation();
    if (submitted) return;
    var data = readDrag(e);
    if (!data) return;
    if (data.from === 'toolbox') {
      if (!verbsById[data.verb]) return;
      slots[targetIndex] = newItem(data.verb);
    } else if (data.from === 'slot') {
      if (data.index === targetIndex || !slots[data.index]) return;
      var tmp = slots[targetIndex];
      slots[targetIndex] = slots[data.index];
      slots[data.index] = tmp;
      metrics.move_count++;
    } else {
      return;
    }
    render();
  }

  // 타임라인 빈 곳에 놓기: Toolbox 카드만 맨 뒤에 추가
  function onDropTimeline(e) {
    e.preventDefault();
    var data = readDrag(e);
    if (data && data.from === 'toolbox') addCard(data.verb);
  }

  function newItem(verbId) {
    var params = {};
    verbsById[verbId].params.forEach(function (p) { params[p.name] = ''; });
    return { verb: verbId, params: params };
  }

  function render() {
    var tl = document.getElementById('timeline');
    tl.innerHTML = '';
    slots.forEach(function (item, i) {
      var slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.slot = i;
      var idx = document.createElement('div');
      idx.className = 'slot-index';
      idx.textContent = String(i + 1);
      slot.appendChild(idx);
      slot.appendChild(buildSlotCard(i));

      slot.addEventListener('dragover', function (e) {
        e.preventDefault();
        slot.classList.add('over');
      });
      slot.addEventListener('dragleave', function () { slot.classList.remove('over'); });
      slot.addEventListener('drop', function (e) { onDrop(i, e); });
      tl.appendChild(slot);
    });
    if (!slots.length) {
      var hint = document.createElement('div');
      hint.className = 'timeline-hint';
      hint.textContent = 'Click a card in the Toolbox or drag it here';
      tl.appendChild(hint);
    }
    document.getElementById('limit-note').textContent =
      slots.length + ' / ' + maxSteps + (isFull() ? ' — no more cards can be added' : '');
    document.querySelectorAll('#toolbox-cards .card').forEach(function (c) {
      c.classList.toggle('disabled', submitted || isFull());
    });
    updateSubmit();
  }

  function isComplete() {
    return slots.length > 0 && slots.every(function (item) {
      return verbsById[item.verb].params.every(function (p) { return item.params[p.name]; });
    });
  }

  function updateSubmit() {
    var btn = document.getElementById('submit-btn');
    btn.disabled = submitted || (config.requireComplete ? !isComplete() : false);
  }

  Promise.all([
    fetch('config/vocab.json').then(function (r) { return r.json(); }),
    fetch('config/config.json').then(function (r) { return r.json(); })
  ]).then(function (res) {
    vocab = res[0];
    config = res[1];
    if (config.requireComplete === undefined) config.requireComplete = true;
    if (!Array.isArray(config.allowedOrigins)) config.allowedOrigins = [];
    vocab.verbs.forEach(function (v) { verbsById[v.id] = v; });
    entities = vocab.pools;
    document.getElementById('submit-btn').addEventListener('click', submit);
    var tl = document.getElementById('timeline');
    tl.addEventListener('dragover', function (e) { e.preventDefault(); });
    tl.addEventListener('drop', onDropTimeline);
    renderToolbox();
    ready = true;
    // 개발 모드에서만: 체크포인트 없이 ?n=3 으로 바로 시작
    if (config.devMode && new URLSearchParams(location.search).has('n')) {
      startTrial(getN());
      render();
      document.getElementById('panel').hidden = false;
    }
    pendingMessages.splice(0).forEach(handleMessage);
  });
})();
