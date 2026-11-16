(function () {
  'use strict';

  var PLACEHOLDER = 'Select...';
  var MODES = ['board', 'tiles', 'places', 'dropdown'];

  var vocab, config;
  var verbsById = {};
  var entities;          // {locations:[], surfaces:[], objects:[], devices:[]}
  var inputMode = 'tiles';
  var slots = [];        // {verb, params: {name: value}} — 카드를 추가한 만큼만 존재
  var maxSteps = Infinity;    // 추가할 수 있는 최대 카드 수. n이 없으면 제한 없음

  var metrics = null, t0 = 0, submitted = false, locked = false;
  var activeSlot = null;  // board 모드: 그림으로 채울 빈칸 {index, param}
  var insertAfter = null; // board 모드: "+"를 누른 카드 번호. 다음 카드는 그 뒤에 끼워진다 (null이면 맨 뒤)
  var popIndex = -1;     // board 모드: 방금 추가된 카드(팝업 애니메이션 대상)
  var picker = null;     // tiles 모드 선택창 상태: {verb, step, values, edit, index}
  var unity = null;      // Unity 모드일 때만 존재
  var unityMode = false; // 설정 오류로 unity가 만들어지지 않아도 부모의 checkpoint는 무시
  var trial = { trial_id: null, checkpoint_id: null };
  var pendingMessages = [];   // config 로딩 전에 도착한 메시지
  var ready = false;
  var studyLog = null;

  function $(id) { return document.getElementById(id); }

  // ---------- 지표 / 트라이얼 ----------

  // 새 체크포인트 시작: 지표 초기화. keepPlan이면 이전 카드를 그대로 둔다.
  function startTrial(n, keepPlan) {
    insertAfter = null;
    if (!keepPlan) slots = [];
    maxSteps = n == null ? Infinity : n;
    metrics = {
      opened_at: new Date().toISOString(),
      first_drag_ms: null,
      total_ms: null,
      move_count: 0,
      delete_count: 0,
      param_change_count: 0,
      click_count: 0,
      unity_pick_count: 0,
      unity_pick_rejected: 0,
      input_mode: inputMode,
      prefilled_cards: slots.length
    };
    t0 = performance.now();
    submitted = false;
    if (studyLog) studyLog.begin(buildResponse());
  }

  function markFirstDrag() {
    if (metrics.first_drag_ms === null) metrics.first_drag_ms = Math.round(performance.now() - t0);
  }

  function editable() { return !!metrics && !locked && !submitted; }

  // ---------- 어휘 / 선택지 ----------

  function labelFor(id) {
    if (vocab.labels && vocab.labels[id]) return vocab.labels[id];
    return String(id).replace(/_st$/, '').replace(/_/g, ' ');
  }

  // 같은 id가 풀마다 다를 수 있으므로(beans 등) 파라미터가 쓰는 풀 안에서만 이미지를 찾는다
  function imageFor(param, id) {
    var imgs = vocab.images || {};
    for (var i = 0; i < param.pools.length; i++) {
      var pool = param.pools[i];
      if ((entities[pool] || []).indexOf(id) !== -1 && imgs[pool] && imgs[pool][id]) return imgs[pool][id];
    }
    return null;
  }

  function byLabel(a, b) {
    var x = a.label.toLowerCase(), y = b.label.toLowerCase();
    if (x !== y) return x < y ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  // 풀을 합치고 id 기준 중복 제거 후 표시 이름의 알파벳순으로 고정 (순서가 단서가 되지 않도록)
  function optionsFor(param) {
    var seen = {}, out = [];
    param.pools.forEach(function (pool) {
      (entities[pool] || []).forEach(function (id) {
        if (seen[id]) return;
        seen[id] = true;
        out.push({ id: id, label: labelFor(id), image: imageFor(param, id) });
      });
    });
    return out.sort(byLabel);
  }

  function newItem(verbId) {
    var params = {};
    verbsById[verbId].params.forEach(function (p) { params[p.name] = ''; });
    return { verb: verbId, params: params };
  }

  function buildResponse() {
    return slots.map(function (item, i) {
      if (!item || !item.verb) return { slot: i, verb: null, params: {} };
      var params = {};
      verbsById[item.verb].params.forEach(function (p) {
        params[p.name] = item.params[p.name] || null;
      });
      return { slot: i, verb: item.verb, params: params };
    });
  }

  // ---------- 상태 표시줄 / 잠금 ----------

  function setStatus(text, isError) {
    var bar = $('status-bar');
    bar.textContent = text || '';
    bar.hidden = !text;
    bar.classList.toggle('error', !!isError);
  }

  function setLocked(on) {
    locked = on;
    if (on) closePicker();
    $('toolbox').classList.toggle('locked', on);
    $('timeline-area').classList.toggle('locked', on);
  }

  // ---------- 부모(Qualtrics) 송신 ----------

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

  function postToUnity(msg) {
    unity.frame.contentWindow.postMessage(msg, unity.origin);
  }

  function showDebug(response) {
    if (!(config.devMode && new URLSearchParams(location.search).get('debug') === '1')) return;
    var pre = $('debug-out');
    if (!pre) {
      pre = document.createElement('pre');
      pre.id = 'debug-out';
      $('main').appendChild(pre);
    }
    pre.textContent = JSON.stringify({ response: response, metrics: metrics }, null, 2);
  }

  function submit() {
    if (!editable()) return;
    submitted = true;
    metrics.total_ms = Math.round(performance.now() - t0);
    if (studyLog) Object.assign(metrics, studyLog.submit(buildResponse()));
    closePicker();
    var response = buildResponse();
    render();   // 제출 후 잠금 상태 반영 (Submit 비활성화, Toolbox 흐리게)
    showDebug(response);
    if (unity) {
      sendToParent({
        type: 'response_submitted',
        trial_id: unity.pid,
        checkpoint_id: 'cp' + unity.cp.index,
        response: response,
        metrics: metrics,
        variant_id: unity.variant_id,
        drone_count: unity.drone_count,
        unity: unity.cp
      });
      postToUnity({ source: 'hri_qualtrics', type: 'resume', pid: unity.pid, index: unity.cp.index });
      setLocked(true);
      setStatus('Thanks! Watch the robot...');
    } else {
      sendToParent({
        type: 'response_submitted',
        trial_id: trial.trial_id,
        checkpoint_id: trial.checkpoint_id,
        response: response,
        metrics: metrics
      });
    }
  }

  // ---------- 레거시 모드: 부모가 checkpoint 메시지를 보낸다 ----------

  function isStringArray(a) {
    return Array.isArray(a) && a.every(function (x) { return typeof x === 'string'; });
  }

  function validCheckpoint(m) {
    var ent = m.entities;
    if (!((m.n == null || (Number.isInteger(m.n) && m.n >= 1)) && ent && typeof ent === 'object')) return false;
    return Object.keys(ent).every(function (k) {
      return !Object.prototype.hasOwnProperty.call(vocab.pools, k) || isStringArray(ent[k]);
    });
  }

  function startCheckpoint(m) {
    trial.trial_id = m.trial_id;
    trial.checkpoint_id = m.checkpoint_id;
    // vocab.pools 위에 메시지의 엔티티를 덮어쓴다 (vocab에 있는 풀 이름만)
    entities = {};
    Object.keys(vocab.pools).forEach(function (k) {
      entities[k] = Object.prototype.hasOwnProperty.call(m.entities, k) ? m.entities[k] : vocab.pools[k];
    });
    startTrial(m.n, false);
    closePicker();
    var dbg = $('debug-out');
    if (dbg) dbg.remove();
    render();
    $('panel').hidden = false;
  }

  function handleParentMessage(event) {
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

  // ---------- Unity 모드 ----------

  function handleUnityMessage(event) {
    if (event.source !== unity.frame.contentWindow || event.origin !== unity.origin) return;
    var d = event.data;
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch (err) { return; }
    }
    if (!d || typeof d !== 'object' || d.source !== 'hri_unity' || String(d.pid) !== unity.pid) return;
    if (studyLog && ['ready', 'run_complete', 'error', 'item_clicked']   // hover is not logged (study decision 2026-11-14)
      .indexOf(d.type) !== -1) studyLog.record('unity_' + d.type, d);
    if (d.type === 'ready') onUnityReady(d);
    else if (d.type === 'checkpoint') onUnityCheckpoint(d);
    else if (d.type === 'run_complete') onUnityComplete(d);
    else if (d.type === 'error') onUnityError(String(d.message));
    else if (d.type === 'item_clicked') onUnityItemClicked(String(d.id || ''));
  }

  // Unity 화면 안의 물건을 클릭하면 지금 빈칸에 채운다 (board 모드)
  var pickNoteTimer = null;
  function pickNote(text) {
    var el = $('places-prompt');
    el.textContent = text;
    el.classList.add('pick-warn');
    clearTimeout(pickNoteTimer);
    pickNoteTimer = setTimeout(function () { el.classList.remove('pick-warn'); render(); }, 1800);
  }
  // Unity can report ONE physical click several times within a few milliseconds (several updates share one input snapshot).
  // The first counts, the repeats are dropped: otherwise the repeats hit "no blank selected" and show a false warning.
  var lastPick = { id: '', t: 0 };
  function onUnityItemClicked(id) {
    var now = performance.now();
    if (id === lastPick.id && now - lastPick.t < 300) return;
    lastPick = { id: id, t: now };
    if (studyLog) studyLog.record("item_pick_attempt", {id: id, editable: editable(), target: currentTarget()});
    function outcome(reason) { if (studyLog) studyLog.record('item_pick_result', {id: id, result: reason}); }
    if (inputMode !== 'board' || !editable()) { outcome('not_editable'); return; }
    var key = conceptKey(id);
    var item = boardItems().filter(function (o) { return o.id === key; })[0];
    if (!item) { outcome('unknown_item'); return; }   // 어휘에 없는 물건은 무시
    var target = currentTarget();
    if (!target) { outcome('no_target'); metrics.unity_pick_rejected++; pickNote('Choose an action above first, then click ' + item.label + ' in the simulation.'); return; }
    if (fillSlot(target, key)) { outcome('accepted'); metrics.unity_pick_count++; markFirstDrag(); return; }
    outcome('incompatible_item');
    metrics.unity_pick_rejected++;
    pickNote(item.label + ' does not fit step ' + (target.index + 1) + ' (' + verbsById[slots[target.index].verb].label + ').');
  }

  function onUnityReady(d) {
    if (unity.readySeen) return;
    unity.readySeen = true;
    // Unity sends the aspect (width / height) of the pixel-art scene it frames; the Unity box takes that shape (no sky/ground margins)
    if (typeof d.scene_aspect === 'number' && d.scene_aspect > 0.4 && d.scene_aspect < 3) {
      $('unity-area').style.setProperty('--unity-aspect', String(d.scene_aspect));
    }
    unity.variant_id = d.variant_id;
    unity.drone_count = d.drone_count;
    sendToParent({
      type: 'unity_ready',
      trial_id: unity.pid,
      variant_id: d.variant_id,
      drone_count: d.drone_count,
      layout_seed: d.layout_seed,
      build_version: d.build_version
    });
    setStatus('Watch the robot...');
  }

  function onUnityCheckpoint(d) {
    if (!Number.isInteger(d.index) || d.index < 1 || !Number.isInteger(d.total) || d.total < d.index) {
      console.warn('invalid unity checkpoint ignored');
      return;
    }
    if (d.index <= unity.lastIndex) return;   // 중복/되돌아간 체크포인트는 무시
    unity.lastIndex = d.index;
    unity.cp = {
      index: d.index,
      total: d.total,
      robot_step_index: d.robot_step_index,
      robot_place: d.robot_place,
      drones_shown: d.drones_shown,
      drone_places_shown: d.drone_places_shown,
      utc: d.utc
    };
    if (studyLog) studyLog.record('unity_checkpoint', d);
    var keep = config.carryOverPlan !== false && d.index > 1 && slots.length > 0;
    startTrial(unity.maxSteps, keep);
    // 공변량: 보여 준 드론(방문) 수와 그중 서로 다른 장소 수
    var places = Array.isArray(d.drone_places_shown) ? d.drone_places_shown : [];
    // drones_shown: 화면에 보이는 드론 수 (Unity 값, 재방문은 1대). visits_shown: 드론이 가리키는 방문 수 (중복 포함)
    metrics.drones_shown = typeof d.drones_shown === 'number' ? d.drones_shown : null;
    metrics.visits_shown = places.length;
    metrics.distinct_places_shown = places.filter(function (p, i) { return places.indexOf(p) === i; }).length;
    closePicker();
    var dbg = $('debug-out');
    if (dbg) dbg.remove();
    setLocked(false);
    render();
    var stopped = 'The robot stopped. ';
    // 드론이 있을 때만: 드론이 다음 장소의 힌트라는 안내를 덧붙인다 (드론 0대면 생략)
    var shownDrones = typeof d.drones_shown === 'number' ? d.drones_shown : unity.drone_count;
    var droneHint = shownDrones > 0 ? ' The DRONES give you hints about where the robot goes next.' : '';
    setStatus(keep
      ? stopped + 'What will the robot do next? Feel free to use any actions that are applicable, or delete anything that is not applicable anymore. Then submit.' + droneHint
      : d.index === 1
        ? stopped + 'Enter your first prediction of its WHOLE plan, from the very first step, then submit.' + droneHint
        : stopped + 'What will the robot do next? Feel free to use any actions that are applicable, or delete anything that is not applicable anymore. Then submit.' + droneHint);
    $('status-bar').dataset.checkpoint = String(d.index);   // 번호는 화면에 보이지 않는다 (테스트용 표식)
  }

  function onUnityComplete(d) {
    sendToParent({ type: 'run_complete', trial_id: unity.pid, run_log: d.run_log });
    setLocked(true);
    setStatus('The robot has finished. You can continue by clicking Next page below.');
  }

  function onUnityError(message) {
    sendToParent({ type: 'unity_error', trial_id: unity.pid, message: message });
    setLocked(true);
    setStatus('Something went wrong: ' + message, true);
  }

  function setupUnity(q) {
    var pid = q.get('pid'), drones = q.get('drones'), variant = q.get('variant');
    unityMode = true;
    $('panel').hidden = false;
    setLocked(true);
    render();   // 로딩 중에도 (잠긴 채로) 타임라인과 타일이 보이도록
    if (!/^[0-7]$/.test(drones) || !/^[LS][1-4]$/.test(variant)) {
      sendToParent({ type: 'unity_error', trial_id: pid, message: 'invalid drones/variant parameters' });
      setStatus('Setup error: invalid study parameters.', true);
      return;
    }
    var url = new URL(config.unityUrl, location.href);
    url.searchParams.set('drones', drones);
    url.searchParams.set('variant', variant);
    url.searchParams.set('pid', pid);
    url.searchParams.set('host', location.origin);
    if (/^\d+$/.test(q.get('layout') || '')) url.searchParams.set('layout', q.get('layout'));

    var frame = document.createElement('iframe');
    frame.title = 'Robot simulation';
    frame.allow = 'autoplay';
    frame.src = url.href;
    var area = $('unity-area');
    area.textContent = '';
    area.classList.add('has-frame');
    area.appendChild(frame);

    var cap = parseInt(config.maxSteps, 10);
    unity = {
      pid: pid,
      frame: frame,
      origin: url.origin,
      maxSteps: cap > 0 ? cap : Infinity,
      variant_id: variant,
      drone_count: parseInt(drones, 10),
      readySeen: false,
      lastIndex: 0,
      cp: null
    };
    setStatus('Loading the simulation...');
  }

  // 리스너는 즉시 등록하고, config 로딩 전 메시지는 보관했다가 처리
  window.addEventListener('message', function (event) {
    if (ready) routeMessage(event);
    else pendingMessages.push(event);
  });

  function routeMessage(event) {
    if (unityMode) { if (unity) handleUnityMessage(event); }   // Unity 모드에서는 부모의 checkpoint를 무시
    else handleParentMessage(event);
  }

  function getN() {
    var raw = new URLSearchParams(location.search).get('n');
    var n = parseInt(raw, 10);
    return n >= 1 ? n : null;   // ?n= 이 없거나 잘못되면 제한 없음
  }

  // ---------- 화면: Toolbox / 카드 ----------

  function renderToolbox() {
    if (inputMode === 'places' || inputMode === 'board') { $('toolbox').hidden = true; return; }
    var box = $('toolbox-cards');
    $('side-note').textContent = inputMode === 'tiles'
      ? 'Click an action to add it to the timeline'
      : 'Click an action or drag it to the timeline';
    vocab.verbs.forEach(function (verb) {
      var card = document.createElement('div');
      card.className = 'card';
      card.dataset.verb = verb.id;
      card.textContent = verb.label;
      if (inputMode === 'dropdown') {
        card.draggable = true;
        card.addEventListener('dragstart', function (e) {
          if (!editable()) { e.preventDefault(); return; }
          markFirstDrag();
          e.dataTransfer.effectAllowed = 'copy';
          e.dataTransfer.setData('text/plain', JSON.stringify({ from: 'toolbox', verb: verb.id }));
        });
        card.addEventListener('click', function () { addCard(verb.id); });
      } else {
        card.addEventListener('click', function () { openAddPicker(verb.id); });
      }
      box.appendChild(card);
    });
  }

  function buildDropdownParam(item, param) {
    var wrap = document.createElement('div');
    wrap.className = 'param';
    var cap = document.createElement('span');
    cap.textContent = param.label;
    var sel = document.createElement('select');
    sel.setAttribute('aria-label', param.label);
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = PLACEHOLDER;
    sel.appendChild(ph);
    optionsFor(param).forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt.id;
      o.textContent = opt.label;
      sel.appendChild(o);
    });
    sel.value = item.params[param.name] || '';
    sel.addEventListener('change', function () {
      if (!editable()) { sel.value = item.params[param.name] || ''; return; }
      metrics.param_change_count++;
      item.params[param.name] = sel.value;
      if (studyLog) studyLog.plan(buildResponse());
      updateStatus();
      updateSubmit();
    });
    wrap.appendChild(cap);
    wrap.appendChild(sel);
    return wrap;
  }

  function buildTileParam(item, index, paramIdx, param) {
    var wrap = document.createElement('div');
    wrap.className = 'param';
    var cap = document.createElement('span');
    cap.textContent = param.label;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'param-btn';
    var val = item.params[param.name];
    btn.textContent = val ? labelFor(val) : PLACEHOLDER;
    btn.classList.toggle('empty', !val);
    btn.addEventListener('click', function () { openEditPicker(index, paramIdx); });
    wrap.appendChild(cap);
    wrap.appendChild(btn);
    return wrap;
  }

  // 타임라인 카드를 드래그할 수 있게 한다 (순서 변경)
  function attachDrag(card, index) {
    card.draggable = true;
    card.addEventListener('dragstart', function (e) {
      if (!editable()) { e.preventDefault(); return; }
      markFirstDrag();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify({ from: 'slot', index: index }));
      setTimeout(function () { card.classList.add('dragging'); }, 0);
    });
    card.addEventListener('dragend', function () { card.classList.remove('dragging'); });
  }

  function makeRemoveBtn(index) {
    var rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'remove-btn';
    rm.textContent = '×';
    rm.setAttribute('aria-label', 'Remove');
    rm.addEventListener('click', function () {
      if (!editable()) return;
      closePicker();
      metrics.delete_count++;
      activeSlot = null;
      insertAfter = null;
      slots.splice(index, 1);
      render();
    });
    return rm;
  }

  function buildSlotCard(index) {
    if (inputMode === 'board') return buildBoardCard(index);
    var item = slots[index];
    var verb = verbsById[item.verb];
    var card = document.createElement('div');
    card.className = 'card slot-card';
    attachDrag(card, index);

    var head = document.createElement('div');
    head.className = 'card-head';
    var idx = document.createElement('span');
    idx.className = 'slot-index';
    idx.textContent = String(index + 1);
    var title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = verb.label;
    head.appendChild(idx);
    head.appendChild(title);
    head.appendChild(makeRemoveBtn(index));
    card.appendChild(head);

    if (inputMode === 'places') {
      // 방문할 장소만 보여 주는 compact 카드: 이름 + 이미지
      var loc = item.params.location;
      title.textContent = labelFor(loc);
      card.classList.add('place-card');
      var src = imageFor(verb.params[0], loc);
      if (src) card.appendChild(makeImg(src, 'place-img'));
      return card;
    }

    verb.params.forEach(function (param, paramIdx) {
      card.appendChild(inputMode === 'tiles'
        ? buildTileParam(item, index, paramIdx, param)
        : buildDropdownParam(item, param));
    });
    return card;
  }

  function isFull() { return slots.length >= maxSteps; }

  // dropdown 모드: Toolbox 카드를 클릭하거나 타임라인 빈 곳에 놓으면 맨 뒤에 슬롯이 하나 늘어난다
  function addCard(verbId) {
    if (!editable() || isFull() || !verbsById[verbId]) return;
    markFirstDrag();
    slots.push(newItem(verbId));
    render();
    scrollTimelineToEnd();
  }

  function readDrag(e) {
    try { return JSON.parse(e.dataTransfer.getData('text/plain')); } catch (err) { return null; }
  }

  // 슬롯 위에 놓기: Toolbox 카드는 교체, 슬롯 카드는 맞바꿈
  function onDrop(targetIndex, e) {
    e.preventDefault();
    e.stopPropagation();
    if (!editable()) return;
    var data = readDrag(e);
    if (!data) return;
    if (data.from === 'toolbox') {
      if (inputMode !== 'dropdown' || !verbsById[data.verb]) return;
      closePicker();
      slots[targetIndex] = newItem(data.verb);
    } else if (data.from === 'slot') {
      if (data.index === targetIndex || !slots[data.index]) return;
      if (inputMode === 'board') { moveCard(data.index, targetIndex); return; }
      closePicker();
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
    if (data && data.from === 'toolbox' && inputMode === 'dropdown') addCard(data.verb);
    if (data && data.from === 'verb' && inputMode === 'board') addVerbStep(data.id);
    if (data && data.from === 'tile' && inputMode === 'board') fillFromTile(data.id);
  }

  // ---------- 화면: tiles 선택창 ----------

  function openAddPicker(verbId) {
    if (!editable() || isFull() || !verbsById[verbId]) return;
    markFirstDrag();
    picker = { verb: verbId, step: 0, values: {}, edit: false, index: -1 };
    renderPicker();
  }

  function openEditPicker(index, paramIdx) {
    if (!editable() || !slots[index]) return;
    picker = { verb: slots[index].verb, step: paramIdx, values: null, edit: true, index: index };
    renderPicker();
  }

  function closePicker() {
    picker = null;
    renderPicker();
  }

  function pickTile(id) {
    if (!picker || !editable()) return;
    var verb = verbsById[picker.verb], param = verb.params[picker.step];
    if (picker.edit) {
      var item = slots[picker.index];
      if (item && item.params[param.name] !== id) {
        metrics.param_change_count++;
        item.params[param.name] = id;
      }
      closePicker();
      render();
      return;
    }
    metrics.param_change_count++;
    picker.values[param.name] = id;
    if (picker.step + 1 < verb.params.length) {
      picker.step++;
      renderPicker();
    } else {
      slots.push({ verb: picker.verb, params: picker.values });
      closePicker();
      render();
      scrollTimelineToEnd();
    }
  }

  function makeImg(src, className) {
    var img = document.createElement('img');
    img.alt = '';
    img.src = src;
    if (className) img.className = className;
    img.addEventListener('error', function () { img.remove(); });   // 로드 실패 시 이름만 남긴다
    return img;
  }

  function buildTile(opt, selected) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tile' + (selected ? ' selected' : '');
    btn.dataset.id = opt.id;
    if (opt.image) btn.appendChild(makeImg(opt.image));
    var label = document.createElement('span');
    label.textContent = opt.label;
    btn.appendChild(label);
    btn.addEventListener('click', function () { pickTile(opt.id); });
    return btn;
  }

  function renderPicker() {
    var box = $('picker');
    if (!picker) {
      box.hidden = true;
      $('picker-tiles').textContent = '';
      return;
    }
    var verb = verbsById[picker.verb], param = verb.params[picker.step];
    var title = verb.label + ' - ' + (param.prompt || param.label);
    if (!picker.edit && verb.params.length > 1) title += ' (' + (picker.step + 1) + ' of ' + verb.params.length + ')';
    $('picker-title').textContent = title;
    var current = picker.edit ? slots[picker.index].params[param.name] : null;
    var tiles = $('picker-tiles');
    tiles.textContent = '';
    optionsFor(param).forEach(function (opt) {
      tiles.appendChild(buildTile(opt, opt.id === current));
    });
    box.hidden = false;
  }

  // ---------- 화면: board 모드 (이미지 타일 + 카드마다 동사 선택) ----------

  function poolsHave(pools, id) {
    return pools.some(function (p) { return (entities[p] || []).indexOf(id) !== -1; });
  }

  // board 타일은 "대상" 단위로 하나: 장소 id와 물건 id가 같은 것을 가리키면(pot_st/pot, mug_st/mug, filter_st/filter)
  // 하나로 합친다. 대상 키 = id에서 _st를 뗀 값. 동사를 고르면 그 파라미터 풀에 있는 id로 바뀐다.
  // Unity 화면에서 물건을 클릭해 고르는 방식: config.pickInUnity가 true이고 Unity가 연결된 경우
  function pickInUnity() { return !!(config && config.pickInUnity && unity); }

  function conceptKey(id) { return String(id).replace(/_st$/, ''); }

  function conceptIds(key) {
    var out = [];
    Object.keys(entities).forEach(function (pool) {
      (entities[pool] || []).forEach(function (id) {
        if (conceptKey(id) === key && out.indexOf(id) === -1) out.push(id);
      });
    });
    return out;
  }

  // 표시 이름: 물건 쪽 이름(_st가 없는 id)을 우선
  function conceptLabel(key) {
    var ids = conceptIds(key);
    return labelFor(ids.indexOf(key) !== -1 ? key : ids[0] || key);
  }

  function conceptImage(key) {
    var imgs = vocab.images || {}, pools = Object.keys(entities), ids = conceptIds(key);
    for (var i = 0; i < pools.length; i++) {
      for (var j = 0; j < ids.length; j++) {
        var pool = pools[i], id = ids[j];
        if ((entities[pool] || []).indexOf(id) !== -1 && imgs[pool] && imgs[pool][id]) return imgs[pool][id];
      }
    }
    return null;
  }

  // 파라미터 풀에 들어 있는 이 대상의 id (없으면 null)
  function conceptIdFor(key, param) {
    var ids = conceptIds(key);
    for (var i = 0; i < ids.length; i++) if (poolsHave(param.pools, ids[i])) return ids[i];
    return null;
  }

  // 타일 목록: 어떤 동사의 첫 파라미터가 될 수 있는 대상, 이름 알파벳순, 중복 없이 한 목록
  function boardItems() {
    var seen = {}, out = [];
    vocab.verbs.forEach(function (v) {
      // 모든 파라미터의 풀: 동작 먼저 방식에서는 어떤 빈칸에 들어가는 대상이든 타일로 고를 수 있어야 한다 (예: Place → Counter)
      [].concat.apply([], v.params.map(function (p) { return p.pools; })).forEach(function (pool) {
        (entities[pool] || []).forEach(function (id) {
          var key = conceptKey(id);
          if (seen[key]) return;
          seen[key] = true;
          out.push({ id: key, label: conceptLabel(key), image: conceptImage(key) });
        });
      });
    });
    return out.sort(byLabel);
  }

  // 순서 변경: from의 카드를 빼서 to 위치에 끼워 넣는다
  // 같은 대상이 연속된 단계들을 카드 하나(그룹)로 묶는다. 데이터는 단계 단위 그대로.
  // 카드 하나 = 단계 하나 (동작 1개 + 대상)
  function boardGroups() {
    return slots.map(function (item, i) { return { start: i, len: 1 }; });
  }

  // 순서 변경: from에서 시작하는 카드(그룹)를 to에서 시작하는 카드 자리로 옮긴다 (to = -1 이면 맨 뒤)
  function moveCard(from, to) {
    var groups = boardGroups();
    var gi = groups.findIndex(function (g) { return g.start === from; });
    var ti = to === -1 ? groups.length - 1 : groups.findIndex(function (g) { return g.start === to; });
    if (gi === -1 || ti === -1 || gi === ti) return;
    var moving = slots.splice(groups[gi].start, groups[gi].len);
    var target = groups[ti];
    // 뒤로 옮기면 대상 카드 뒤에, 앞으로 옮기면 대상 카드 앞에 끼운다
    var at = ti > gi ? target.start + target.len - moving.length : target.start;
    Array.prototype.splice.apply(slots, [at, 0].concat(moving));
    metrics.move_count++;
    activeSlot = null;
    insertAfter = null;
    render();
  }

  function renderBoardTimeline(tl) {
    var groups = boardGroups();
    groups.forEach(function (g, gi) {
      var slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.slot = g.start;
      slot.dataset.len = g.len;
      slot.appendChild(buildBoardCard(g, gi));
      slot.addEventListener('dragover', function (e) { e.preventDefault(); slot.classList.add('over'); });
      slot.addEventListener('dragleave', function () { slot.classList.remove('over'); });
      slot.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        slot.classList.remove('over');
        var data = readDrag(e);
        if (!editable() || !data) return;
        if (data.from === 'slot') moveCard(data.index, g.start);
        else if (data.from === 'verb') addVerbStep(data.id, g.start + g.len);
        else if (data.from === 'tile') fillFromTile(data.id);
      });
      tl.appendChild(slot);
    });
    // 빈 자리는 하나만: 카드가 없으면 전체 폭 안내, 있으면 마지막 카드 뒤에 + 칸 (화면 폭과 무관하게 여백이 안 남는다)
    tl.appendChild(buildGhost(groups.length));
    // 새 단계가 보이도록 오른쪽 끝으로
    if (popIndex >= 0) setTimeout(function () { tl.scrollLeft = tl.scrollWidth; }, 0);
  }

  function buildBoardSelect(className, placeholder, opts, value, onChange) {
    var sel = document.createElement('select');
    sel.className = className;
    sel.setAttribute('aria-label', placeholder);
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = placeholder;
    ph.hidden = !!value;   // 이미 골랐으면 빈 선택지는 숨긴다
    sel.appendChild(ph);
    opts.forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt.id;
      o.textContent = opt.label;
      sel.appendChild(o);
    });
    sel.value = value || '';
    sel.addEventListener('change', function () {
      if (!editable()) { sel.value = value || ''; return; }
      if (sel.value !== (value || '')) onChange(sel.value);
    });
    return sel;
  }

  // ---- board: 동작을 먼저 고르고, 그림으로 빈칸(대상)을 채운다 ----
  function newStep(verbId) {
    var item = { verb: verbId, params: {} };
    verbsById[verbId].params.forEach(function (p) { item.params[p.name] = ''; });
    return item;
  }

  function paramOf(index, name) {
    return verbsById[slots[index].verb].params.filter(function (p) { return p.name === name; })[0];
  }

  function firstEmpty(index) {
    var item = slots[index];
    if (!item || !item.verb) return null;
    var ps = verbsById[item.verb].params;
    for (var k = 0; k < ps.length; k++) if (!item.params[ps[k].name]) return ps[k].name;
    return null;
  }

  // 그림을 누르면 채워질 빈칸: 선택된 빈칸, 없으면 가장 최근의 빈칸
  function currentTarget() {
    if (activeSlot && slots[activeSlot.index] && slots[activeSlot.index].params[activeSlot.param] === '') return activeSlot;
    for (var i = slots.length - 1; i >= 0; i--) {
      var n = firstEmpty(i);
      if (n) return { index: i, param: n };
    }
    return null;
  }

  // vocab.rules: 대상 조합 제한. rules[verb][param] = { allow | deny }
  //   allow/deny가 배열이면 그 파라미터에 올 수 있는/없는 값 목록,
  //   객체면 첫 파라미터 값(예: 붓는 물건)별 목록. 목록이 없는 값은 제한 없음.
  function ruleAllows(item, param, id) {
    var rule = vocab.rules && vocab.rules[item.verb] && vocab.rules[item.verb][param.name];
    if (!rule) return true;
    var firstName = verbsById[item.verb].params[0].name;
    function pick(r) {
      if (!r) return null;
      if (Array.isArray(r)) return r;
      var key = item.params[firstName];
      return param.name !== firstName && key && Array.isArray(r[key]) ? r[key] : null;
    }
    var allow = pick(rule.allow), deny = pick(rule.deny);
    if (allow && allow.indexOf(id) === -1) return false;
    if (deny && deny.indexOf(id) !== -1) return false;
    return true;
  }

  function accepts(target, key) {
    if (!target) return false;
    var param = paramOf(target.index, target.param);
    var id = conceptIdFor(key, param);
    return id !== null && ruleAllows(slots[target.index], param, id);
  }

  function addVerbStep(verbId, at) {
    if (!editable() || isFull() || !verbsById[verbId]) return;
    markFirstDrag();
    if (at === undefined && insertAfter !== null) {
      at = insertAfter + 1;
      insertAfter = at;   // 연속으로 넣으면 방금 넣은 카드 뒤에 이어서 들어간다
    }
    if (at === undefined || at > slots.length) at = slots.length;
    slots.splice(at, 0, newStep(verbId));
    activeSlot = { index: at, param: firstEmpty(at) };
    popIndex = at;
    render();
  }

  function fillSlot(target, key) {
    if (!editable() || !accepts(target, key)) return false;
    var item = slots[target.index];
    item.params[target.param] = conceptIdFor(key, paramOf(target.index, target.param));
    metrics.param_change_count++;
    // 첫 대상이 바뀌어 기존 두 번째 대상이 규칙에 맞지 않게 되면 비운다
    verbsById[item.verb].params.forEach(function (p) {
      if (p.name !== target.param && item.params[p.name] && !ruleAllows(item, p, item.params[p.name])) item.params[p.name] = '';
    });
    var next = firstEmpty(target.index);
    activeSlot = next ? { index: target.index, param: next } : null;
    render();
    return true;
  }

  function fillFromTile(key) { fillSlot(currentTarget(), key); }

  function buildSlotButton(index, param) {
    var item = slots[index];
    var val = item.params[param.name];
    var t = currentTarget();
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slot-btn' + (val ? '' : ' empty') + (t && t.index === index && t.param === param.name ? ' active' : '');
    btn.dataset.param = param.name;
    if (val) {
      // 계획 카드에는 이름만 표시한다 (그림은 선택기/타일에만)
      var nm = document.createElement('span');
      nm.textContent = labelFor(val);
      btn.appendChild(nm);
      btn.title = 'Click to change';
    } else {
      btn.textContent = param.hint || ('Which ' + param.label + '?');
    }
    // 누르면 이 칸을 선택 (채워져 있으면 비우고 다시 고르게 한다)
    btn.addEventListener('click', function () {
      if (!editable()) return;
      if (item.params[param.name]) { item.params[param.name] = ''; metrics.param_change_count++; }
      activeSlot = { index: index, param: param.name };
      render();
    });
    // 그림을 이 칸에 직접 끌어다 놓기
    btn.addEventListener('dragover', function (e) { e.preventDefault(); });
    btn.addEventListener('drop', function (e) {
      var data = readDrag(e);
      if (!data || data.from !== 'tile') return;
      e.preventDefault();
      e.stopPropagation();
      fillSlot({ index: index, param: param.name }, data.id);
    });
    return btn;
  }

  // 카드 한 장: 머리줄(번호 · 동작 · ×) + 대상 칸들 (한 줄에 하나씩, 두 번째 칸 앞에는 연결어)
  function buildStepRow(index) {
    var item = slots[index];
    var verb = verbsById[item.verb];
    var row = document.createElement('div');
    row.className = 'step-row' + (isItemComplete(item) ? '' : ' needs-action');
    var head = document.createElement('div');
    head.className = 'step-head';
    var num = document.createElement('span');
    num.className = 'step-num';
    num.textContent = String(index + 1);   // 전체 계획에서의 단계 번호
    head.appendChild(num);
    var v = document.createElement('span');
    v.className = 'step-verb';
    v.textContent = verb.label;
    head.appendChild(v);
    var rm = makeRemoveBtn(index);
    rm.classList.add('step-remove');
    rm.setAttribute('aria-label', 'Remove step');
    head.appendChild(rm);
    row.appendChild(head);
    var fields = document.createElement('div');
    fields.className = 'step-fields';
    verb.params.forEach(function (p, k) {
      if (k > 0) {
        var link = document.createElement('span');
        link.className = 'step-link';
        link.textContent = p.name === 'target' ? 'into' : p.name === 'location' ? 'at' : '';
        fields.appendChild(link);
      }
      fields.appendChild(buildSlotButton(index, p));
    });
    row.appendChild(fields);
    return row;
  }


  function buildBoardCard(g, gi) {
    var card = document.createElement('div');
    card.className = 'card slot-card board-card' + (popIndex === g.start ? ' pop' : '') + (insertAfter === g.start ? ' insert-after' : '');
    attachDrag(card, g.start);
    card.appendChild(buildStepRow(g.start));
    return card;
  }

  function renderBoardGrid() {
    var counts = {};
    slots.forEach(function (item) {
      Object.keys(item.params).forEach(function (k) {
        var v = item.params[k];
        if (v) counts[conceptKey(v)] = (counts[conceptKey(v)] || 0) + 1;
      });
    });
    var target = currentTarget();
    var inUnity = pickInUnity();
    var where = inUnity ? 'click an object in the simulation' : 'tap a picture';
    if ($('places-prompt').classList.contains('pick-warn')) { /* 잠깐 경고를 보여 주는 중 */ }
    else $('places-prompt').textContent = !slots.length
      ? 'First choose an action above, then ' + where + ' to fill it in.'
      : target
        ? (inUnity ? 'Click an object in the simulation for step ' : 'Tap a picture for step ') + (target.index + 1) + ' (' + verbsById[slots[target.index].verb].label + ')' + (inUnity ? '.' : ', or drag it onto a blank.')
        : insertAfter !== null
          ? 'The next action will be added after step ' + (insertAfter + 1) + '. Click + again to add at the end.'
          : 'Add the next action above. Drag cards to change the order.';
    var grid = $('places-grid');
    grid.textContent = '';
    grid.hidden = inUnity;   // Unity에서 고르면 그림 타일은 숨긴다
    document.querySelectorAll('#verb-bar .verb-chip').forEach(function (c) { c.disabled = !editable() || isFull(); });
    if (inUnity) return;
    boardItems().forEach(function (opt) {
      var btn = buildTile(opt, !!counts[opt.id]);
      btn.classList.add('board-tile');
      var ok = accepts(target, opt.id);
      btn.disabled = !editable() || !ok;
      if (counts[opt.id]) {
        var badge = document.createElement('span');
        badge.className = 'place-badge';
        badge.textContent = String(counts[opt.id]);
        btn.appendChild(badge);
      }
      btn.addEventListener('click', function () { fillFromTile(opt.id); });
      btn.draggable = editable();
      btn.addEventListener('dragstart', function (e) {
        if (!editable()) { e.preventDefault(); return; }
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', JSON.stringify({ from: 'tile', id: opt.id }));
      });
      grid.appendChild(btn);
    });
  }

  function renderVerbBar() {
    var bar = document.createElement('div');
    bar.id = 'verb-bar';
    var cap = document.createElement('span');
    cap.className = 'verb-bar-label';
    cap.textContent = 'Add an action:';
    bar.appendChild(cap);
    vocab.verbs.forEach(function (v) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'verb-chip';
      b.dataset.verb = v.id;
      b.textContent = v.label;
      b.draggable = true;
      b.addEventListener('click', function () { addVerbStep(v.id); });
      b.addEventListener('dragstart', function (e) {
        if (!editable()) { e.preventDefault(); return; }
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', JSON.stringify({ from: 'verb', id: v.id }));
      });
      bar.appendChild(b);
    });
    $('timeline-area').insertBefore(bar, $('timeline'));
  }

  // ---------- 화면: places 모드 (이미지 타일 그리드) ----------

  function placeParam() { return verbsById.move_to.params[0]; }

  function addPlace(id) {
    if (!editable() || isFull()) return;
    markFirstDrag();
    metrics.param_change_count++;   // 타일을 고른 횟수
    slots.push({ verb: 'move_to', params: { location: id } });
    render();
    scrollTimelineToEnd();
  }

  function renderPlacesGrid() {
    var counts = {};
    slots.forEach(function (item) {
      var id = item.params.location;
      counts[id] = (counts[id] || 0) + 1;
    });
    var grid = $('places-grid');
    grid.textContent = '';
    optionsFor(placeParam()).forEach(function (opt) {
      var btn = buildTile(opt, !!counts[opt.id]);
      btn.classList.add('place-tile');
      btn.disabled = !editable() || isFull();
      if (counts[opt.id]) {
        var badge = document.createElement('span');
        badge.className = 'place-badge';
        badge.textContent = String(counts[opt.id]);
        btn.appendChild(badge);
      }
      btn.addEventListener('click', function () { addPlace(opt.id); });
      grid.appendChild(btn);
    });
  }

  // ---------- 화면: 타임라인 ----------

  // 카드 수 / 미완성 카드 수 표시와 미완성 카드(.incomplete) 표시 갱신
  function updateStatus() {
    var incomplete = 0;
    document.querySelectorAll('#timeline .slot:not(.empty)').forEach(function (el) {
      var start = Number(el.dataset.slot), len = Number(el.dataset.len || 1), left = 0;
      for (var k = start; k < start + len; k++) if (!isItemComplete(slots[k])) left++;
      el.classList.toggle('incomplete', left > 0);
      incomplete += left;
    });
    var unit = inputMode === 'board' ? ' step' : ' card';
    var note = isFinite(maxSteps)
      ? slots.length + ' / ' + maxSteps + (isFull() ? ' - limit reached' : '')
      : slots.length + unit + (slots.length === 1 ? '' : 's');
    if (incomplete) note += ' \u00b7 ' + incomplete + ' to finish';
    $('limit-note').textContent = note;
  }

  function isItemComplete(item) {
    return !!item.verb && verbsById[item.verb].params.every(function (p) { return item.params[p.name]; });
  }

  // 새 카드가 보이도록 타임라인 맨 아래로 (타임라인이 스크롤될 때만 의미가 있다)
  function scrollTimelineToEnd() {
    var tl = $('timeline');
    tl.scrollTop = tl.scrollHeight;
  }

  function render() {
    if (studyLog) studyLog.plan(buildResponse());
    var tl = $('timeline');
    var scrollTop = tl.scrollTop, scrollLeft = tl.scrollLeft;
    tl.innerHTML = '';
    if (inputMode === 'board') renderBoardTimeline(tl);
    else slots.forEach(function (item, i) {
      var slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.slot = i;
      slot.appendChild(buildSlotCard(i));

      slot.addEventListener('dragover', function (e) {
        e.preventDefault();
        slot.classList.add('over');
      });
      slot.addEventListener('dragleave', function () { slot.classList.remove('over'); });
      slot.addEventListener('drop', function (e) { onDrop(i, e); });
      tl.appendChild(slot);
    });
    if (!slots.length && inputMode !== 'board') {
      var hint = document.createElement('div');
      hint.className = 'timeline-hint';
      hint.textContent = inputMode === 'places'
        ? 'Click the places below, in the order the robot will visit them'
        : inputMode === 'tiles'
          ? 'Click an action in the Toolbox to add it here'
          : 'Click a Toolbox card or drag it here';
      tl.appendChild(hint);
    }
    tl.scrollTop = scrollTop;
    tl.scrollLeft = scrollLeft;
    updateStatus();
    document.querySelectorAll('#toolbox-cards .card').forEach(function (c) {
      c.classList.toggle('disabled', !editable() || isFull());
    });
    if (inputMode === 'places') renderPlacesGrid();
    else if (inputMode === 'board') renderBoardGrid();
    popIndex = -1;
    updateSubmit();
  }

  function buildGhost(i) {
    var ghost = document.createElement('div');
    ghost.className = 'slot empty';
    var inner = document.createElement('div');
    inner.className = 'ghost';
    if (i === 0) {
      ghost.classList.add('start');
      inner.textContent = 'Choose an action above to start your plan';
    } else {
      inner.textContent = '+';
    }
    ghost.appendChild(inner);
    ghost.addEventListener('dragover', function (e) { e.preventDefault(); ghost.classList.add('over'); });
    ghost.addEventListener('dragleave', function () { ghost.classList.remove('over'); });
    ghost.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      ghost.classList.remove('over');
      var data = readDrag(e);
      if (!editable() || !data) return;
      if (data.from === 'slot') moveCard(data.index, -1);
      else if (data.from === 'verb') addVerbStep(data.id);
      else if (data.from === 'tile') fillFromTile(data.id);
    });
    return ghost;
  }

  function isComplete() {
    return slots.length > 0 && slots.every(isItemComplete);
  }

  function updateSubmit() {
    $('submit-btn').disabled = !editable() || (config.requireComplete ? !isComplete() : false);
  }

  // ---------- 초기화 ----------

  function countClick() {
    if (editable()) metrics.click_count++;
  }

  Promise.all([
    fetch('config/vocab.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }),
    fetch('config/config.json', { cache: 'no-cache' }).then(function (r) { return r.json(); })
  ]).then(function (res) {
    vocab = res[0];
    vocab.verbs = vocab.verbs.filter(function (v) { return v.enabled !== false; });   // "enabled": false 인 동사는 숨긴다
    config = res[1];
    if (config.requireComplete === undefined) config.requireComplete = true;
    if (!Array.isArray(config.allowedOrigins)) config.allowedOrigins = [];
    vocab.verbs.forEach(function (v) { verbsById[v.id] = v; });
    entities = vocab.pools;

    var q = new URLSearchParams(location.search);
    var mode = q.get('mode') || config.inputMode;
    inputMode = MODES.indexOf(mode) !== -1 ? mode : 'tiles';
    $('panel').classList.add('mode-' + inputMode);
    if (inputMode === 'board') {
      $('timeline-title').textContent = 'Your Plan';
      renderVerbBar();
      $('places').hidden = false;
    }
    if (inputMode === 'places') {
      if (!verbsById.move_to) throw new Error('places mode needs the move_to verb in vocab.json');
      $('timeline-title').textContent = 'Predicted Route';
      $('places-prompt').textContent = 'Where will the robot go? Click the places in the order the robot will visit them, then press Submit.';
      $('places').hidden = false;
    }

    $('submit-btn').addEventListener('click', submit);
    $('picker-cancel').addEventListener('click', closePicker);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && picker) closePicker();
    });
    // 캡처 단계에서 세므로 Submit 클릭도 포함된다
    $('toolbox').addEventListener('click', countClick, true);
    $('timeline-area').addEventListener('click', countClick, true);
    var tl = $('timeline');
    tl.addEventListener('dragover', function (e) { e.preventDefault(); });
    tl.addEventListener('drop', onDropTimeline);
    renderToolbox();

    var pid = q.get('pid'), drones = q.get('drones'), variant = q.get('variant');
    if (config.unityUrl && pid && drones !== null && variant) {
      setupUnity(q);
      if (inputMode === 'board') render();   // Unity가 연결됐으니 대기 화면에서도 그림 타일을 숨긴다 (Unity에서 고르는 방식)
    } else if (config.devMode && q.has('n')) {
      // 개발 모드에서만: 체크포인트 없이 ?n=3 으로 바로 시작
      startTrial(getN(), false);
      render();
      $('panel').hidden = false;
    }
    studyLog = window.createStudyLog(sendToParent, function () {
      return {trial_id: unity ? unity.pid : trial.trial_id, checkpoint_id: unity && unity.cp ? 'cp' + unity.cp.index : trial.checkpoint_id};
    });
    window.studyLog = studyLog; // researcher-only console export: studyLog.download()
    if (metrics && !submitted) studyLog.begin(buildResponse());
    ready = true;
    pendingMessages.splice(0).forEach(routeMessage);
    // 시작 조건(Unity 파라미터 또는 부모의 checkpoint)을 못 받으면 빈 화면 대신 안내를 보여 준다
    setTimeout(function () { if ($('panel').hidden) $('idle-note').hidden = false; }, 1500);
  });
})();
