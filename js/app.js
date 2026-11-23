(function () {
  'use strict';

  // UI practice before the study: ?tutorial=1 (variant T1, drones 0). Loads config/tutorial.json (coach steps + vocab overlay).
  var tutorialMode = new URLSearchParams(location.search).get('tutorial') === '1';
  var tutorialCfg = null, coach = null;
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
  var allVerbs = [];     // vocab.verbs before the "enabled" filter: used to label the robot's done steps
  // Undo/Redo: JSON snapshots of `slots`. Reset at every checkpoint, so Undo never goes back past the carried-over plan.
  var history = { past: [], future: [], current: '[]' };
  var confirmOpen = false;

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
      undo_count: 0,
      redo_count: 0,
      submit_cancel_count: 0,
      input_mode: inputMode,
      prefilled_cards: slots.length
    };
    resetHistory();
    t0 = performance.now();
    submitted = false;
    if (studyLog) studyLog.begin(buildResponse());
  }

  function markFirstDrag() {
    if (metrics.first_drag_ms === null) metrics.first_drag_ms = Math.round(performance.now() - t0);
  }

  var plantPractice = new URLSearchParams(location.search).get('practice') === 'plant';

  var practiceCP = 1;
  function finishPracticePlan() {
    var steps = buildResponse();
    var actions = steps.filter(function (s) { return s.verb !== 'move_to'; });
    var valid = practiceCP === 1
      ? actions.length === 2 && actions[0].verb === 'grab' && actions[0].params.object === 'plant' &&
        actions[1].verb === 'place' && actions[1].params.object === 'plant' && actions[1].params.location === 'brown_table'
      : actions.length === 1 && actions[0].verb === 'turn_on' && actions[0].params.device === 'lamp';
    if (!valid) {
      setStatus(practiceCP === 1 ? 'Hint: grab the plant, then place the plant on the brown table. Edit your plan and submit again.' : 'Hint: choose Turn on, then select Lamp and submit again.');
      return;
    }
    if (practiceCP === 1) {
      practiceCP = 2;
      activeSlot = null;
      startCheckpoint({trial_id:'plant-practice', checkpoint_id:'practice2', entities:{}});
      setStatus('Great job! Practice 2 of 2: enter a plan to turn on the lamp.');
      return;
    }
    submitted = true;
    render(); setLocked(true); $('plant-targets').hidden = true;
    setStatus('Great job! Practice complete. You can explore the room.');
    if (new URLSearchParams(location.search).has('pid')) {
      var next = document.createElement('button');
      next.textContent = 'Start main study';
      next.onclick = function () {
        var url = new URL(location.href);
        url.searchParams.delete('practice');
        url.searchParams.set('practice_done','1');
        location.replace(url.href);
      };
      $('status-bar').append(' ',next);
    }
  }

  function openPlantRoom() {
    var area = $('unity-area');
    area.textContent = '';
    area.classList.add('has-frame', 'plant-room');
    var frame = document.createElement('iframe');
    frame.title = 'Plant practice room';
    frame.src = 'practice_web/index.html';
    // Keep Unity and its hit regions in a single camera coordinate system.
    var stage = document.createElement('div');
    stage.className = 'practice-stage';
    area.appendChild(stage);
    stage.appendChild(frame);
    frame.onload = function () {
      var css = frame.contentDocument.createElement('style');
      css.textContent = '#unity-footer{display:none} #unity-container.unity-desktop{inset:0;transform:none} #unity-canvas{display:block}';
      frame.contentDocument.head.appendChild(css);
    };
    new ResizeObserver(function () {
      var scale = Math.min(area.clientWidth / 960, area.clientHeight / 600);
      stage.style.transform = 'translate(-50%, -50%) scale(' + scale + ')';
    }).observe(area);
    var layer = document.createElement('div');
    layer.id = 'plant-targets';
    stage.appendChild(layer);
    // Positions in the fixed 960 by 600 practice camera view.
    [['plant',74,14,6,11], ['brown_table',62,70,19,22], ['lamp',71,95,6,10]].forEach(function (spot) {
      var button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', vocab.labels[spot[0]]);
      var label = document.createElement('span');
      label.textContent = vocab.labels[spot[0]];
      button.appendChild(label);
      Object.assign(button.style, {left:spot[1]+'%', top:spot[2]+'%', width:spot[3]+'%', height:spot[4]+'%'});
      button.onclick = function () { fillFromTile(spot[0]); };
      layer.appendChild(button);
    });
    startCheckpoint({trial_id:'plant-practice', checkpoint_id:'practice', entities:{}});
    renderDone([]);
    setStatus('Practice 1 of 2: move the plant to the brown table. Build your plan and submit it.');
  }

  function editable() { return !!metrics && !locked && !submitted; }

  // ---------- Undo / Redo ----------

  function resetHistory() {
    history = { past: [], future: [], current: JSON.stringify(slots) };
  }

  // Called from render() (every edit ends there) and from the dropdown select handler (the one edit without render).
  function recordHistory() {
    var now = JSON.stringify(slots);
    if (now === history.current) return;
    history.past.push(history.current);
    history.future = [];
    history.current = now;
  }

  function applyHistory(from, to, counter) {
    if (!editable() || !from.length) return;
    to.push(history.current);
    history.current = from.pop();
    slots = JSON.parse(history.current);
    activeSlot = null;
    insertAfter = null;
    closePicker();
    metrics[counter]++;
    render();
    tutorialEvent(counter === 'undo_count' ? 'undo' : 'redo');
  }

  function undo() { applyHistory(history.past, history.future, 'undo_count'); }
  function redo() { applyHistory(history.future, history.past, 'redo_count'); }

  function updateHistoryButtons() {
    var u = $('undo-btn'), r = $('redo-btn');
    if (u) u.disabled = !editable() || !history.past.length;
    if (r) r.disabled = !editable() || !history.future.length;
  }

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
    if (on) { closePicker(); closeConfirm(false); }
    $('toolbox').classList.toggle('locked', on);
    $('timeline-area').classList.toggle('locked', on);
  }

  // ---------- 부모(Qualtrics) 송신 ----------

  // targetOrigin은 config에서만 읽는다. "*"는 devMode에서만 허용.
  function sendToParent(msg) {
    if (tutorialMode) msg.phase = 'tutorial';
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

  // ---------- Submit confirmation (in-page dialog: window.confirm is blocked in the cross-origin Qualtrics iframe) ----------
  // Writing time keeps running while the dialog is open; the real submit happens only on "Yes, submit".

  function openConfirm() {
    if (!editable() || confirmOpen || $('submit-btn').disabled) return;
    if (coach && !coach.allowSubmit()) { coach.nudge(); return; }
    confirmOpen = true;
    var n = slots.length;
    $('confirm-count').textContent = 'Your plan has ' + n + (n === 1 ? ' step.' : ' steps.');
    $('confirm').hidden = false;
    $('panel').inert = true;   // nothing behind the dialog (cards, Unity) can be clicked or focused
    if (studyLog) studyLog.record('submit_confirm_open', {steps: n});
    $('confirm-back').focus();
  }

  // cancelled = the participant went back to edit (counted and logged); false = closed by the app (submit / lock)
  function closeConfirm(cancelled) {
    if (!confirmOpen) return;
    confirmOpen = false;
    $('confirm').hidden = true;
    $('panel').inert = false;
    if (cancelled) {
      if (metrics) metrics.submit_cancel_count++;
      if (studyLog) studyLog.record('submit_confirm_cancel', {steps: slots.length});
      $('submit-btn').focus();
    }
  }

  function confirmSubmit() {
    if (!confirmOpen) return;
    closeConfirm(false);
    var wasSubmitted = submitted;
    submit();
    if (!wasSubmitted && submitted) tutorialEvent('submit');
  }

  function submit() {
    if (!editable()) return;
    if (coach && !coach.allowSubmit()) { coach.nudge(); return; }
    if (plantPractice) { finishPracticePlan(); return; }
    var submittedUtc = new Date().toISOString();
    submitted = true;
    metrics.total_ms = Math.round(performance.now() - t0);
    if (studyLog) Object.assign(metrics, studyLog.submit(buildResponse()));
    closePicker();
    metrics.response_vocabulary_version = vocab.response_vocabulary_version || 'legacy';
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
      postToUnity({ source: 'hri_qualtrics', type: 'resume', pid: unity.pid, index: unity.cp.index,
        submitted_utc: submittedUtc });
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
    if (m && m.type === 'study_log_ack' && Array.isArray(m.event_ids)) {
      if (studyLog) studyLog.acknowledge(m.event_ids);
      return;
    }
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
    if (['run_started', 'checkpoint_shown', 'checkpoint_submitted', 'checkpoint_resumed', 'run_completed', 'run_aborted'].indexOf(d.type) !== -1) {
      // Acknowledge only after our outbox is persisted locally. This is NOT a server-save acknowledgement.
      if (studyLog && studyLog.record(d.type, d))
        postToUnity({source: 'hri_qualtrics', type: 'event_ack', pid: unity.pid, run_id: d.run_id, event_id: d.event_id});
      if (d.type === 'run_completed' || d.type === 'run_aborted') onUnityComplete(d);
      return;
    }
    if (studyLog && ['ready', 'run_complete', 'error', 'item_clicked']   // hover is not logged (study decision 2026-11-14)
      .indexOf(d.type) !== -1) studyLog.record('unity_' + d.type, d);
    if (d.type === 'ready') onUnityReady(d);
    else if (d.type === 'checkpoint') onUnityCheckpoint(d);
    else if (d.type === 'run_complete') onUnityComplete(d);
    else if (d.type === 'error') onUnityError(String(d.message));
    else if (d.type === 'item_clicked') onUnityItemClicked(String(d.id || ''));
    else if (d.type === 'step_done') onUnityStepDone(d);
  }

  // Unity 화면 안의 물건을 클릭하면 지금 빈칸에 채운다 (board 모드)
  var pickNoteTimer = null;
  function pickNote(text) {
    var el = $('places-prompt');
    el.textContent = text;
    el.classList.add('pick-warn');
    clearTimeout(pickNoteTimer);   // the note stays until the participant's next action (clearPickNote), so it is not missed
  }
  function clearPickNote() { $('places-prompt').classList.remove('pick-warn'); }
  // Unity can report ONE physical click several times within a few milliseconds (several updates share one input snapshot).
  // The first counts, the repeats are dropped: otherwise the repeats hit "no blank selected" and show a false warning.
  var lastPick = { id: '', t: 0 };
  function onUnityItemClicked(id) {
    var now = performance.now();
    if (id === lastPick.id && now - lastPick.t < 300) return;
    lastPick = { id: id, t: now };
    if (studyLog) studyLog.record("item_pick_attempt", {id: id, editable: editable(), target: currentTarget()});
    function outcome(reason) { if (studyLog) studyLog.record('item_pick_result', {id: id, result: reason}); }
    if (inputMode !== 'board' || !editable() || confirmOpen) { outcome('not_editable'); return; }   // no edits behind the submit dialog
    var key = conceptKey(id);
    var item = boardItems().filter(function (o) { return o.id === key; })[0];
    if (!item) { outcome('unknown_item'); return; }   // 어휘에 없는 물건은 무시
    var target = currentTarget();
    if (!target) { outcome('no_target'); metrics.unity_pick_rejected++; pickNote('Choose an action below first, then click ' + item.label + ' in the simulation.'); return; }
    if (fillSlot(target, key)) { outcome('accepted'); metrics.unity_pick_count++; markFirstDrag(); return; }
    var hint = clickHint(key, target);
    if (hint) { outcome('incompatible_item'); metrics.unity_pick_rejected++; pickNote(hint); return; }
    outcome('incompatible_item');
    metrics.unity_pick_rejected++;
    pickNote(item.label + ' does not fit step ' + (target.index + 1) + ' (' + verbsById[slots[target.index].verb].label + ').');
  }

  function onUnityReady(d) {
    if (unity.readySeen) return;
    unity.readySeen = true;
    // Unity sends the aspect (width / height) of the pixel-art scene it frames; the Unity box takes that shape (no sky/ground margins)
    if (typeof d.scene_aspect === 'number' && d.scene_aspect > 0.4 && d.scene_aspect < 3) {
      $('panel').style.setProperty('--unity-aspect', String(d.scene_aspect));   // #panel: the grid columns need it too
    }
    unity.variant_id = d.variant_id;
    unity.drone_count = d.drone_count;
    sendToParent({
      type: 'unity_ready',
      trial_id: unity.pid,
      variant_id: d.variant_id,
      drone_count: d.drone_count,
      layout_seed: d.layout_seed,
      build_version: d.build_version,
      plan_sha256: d.plan_sha256,
      plan_step_count: d.plan_step_count
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
      checkpoint_id: d.checkpoint_id,
      visible_marker_count: d.visible_marker_count,
      drone_markers: d.drone_markers,
      utc: d.utc
    };
    if (studyLog) studyLog.record('unity_checkpoint', d);
    var keep = config.carryOverPlan !== false && d.index > 1 && slots.length > 0;
    startTrial(unity.maxSteps, keep);
    // 공변량: 보여 준 드론(방문) 수와 그중 서로 다른 장소 수
    var places = Array.isArray(d.drone_places_shown) ? d.drone_places_shown : [];
    // drones_shown counts represented visits; visible_marker_count counts actually visible drone markers.
    metrics.drones_shown = typeof d.drones_shown === 'number' ? d.drones_shown : null;
    metrics.visible_marker_count = typeof d.visible_marker_count === 'number' ? d.visible_marker_count : null;
    metrics.visits_shown = places.length;
    metrics.distinct_places_shown = places.filter(function (p, i) { return places.indexOf(p) === i; }).length;
    metrics.steps_done_count = renderDone(d.steps_done);
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
    $('status-bar').dataset.checkpoint = String(d.index);
    tutorialEvent('checkpoint:' + d.index);   // 번호는 화면에 보이지 않는다 (테스트용 표식)
  }

  // ---------- "The robot has done so far" (read-only) ----------
  // Unity sends only the steps it has ALREADY executed (array positions < robot_step_index). The panel never loads
  // variants.json, so it cannot show future steps. Old builds send no steps_done: the section stays hidden.
  function verbForUnity(name) {
    var key = String(name).toLowerCase();
    return allVerbs.filter(function (v) { return v.id === key || String(v.label).toLowerCase() === key || v.id === key.replace(/ /g, '_'); })[0] || null;
  }

  function validDoneStep(s) {
    return !!(s && typeof s === 'object' && typeof s.verb === 'string' && s.verb && isStringArray(s.args));
  }

  function doneKey(s) { return s.verb + '|' + s.args.join('|'); }

  // One item: label only (no picture). Unknown ids are shown as raw text.
  function doneItem(id) {
    var span = document.createElement('span');
    span.className = 'done-item';
    span.appendChild(document.createTextNode(vocab.labels && vocab.labels[id] ? vocab.labels[id] : id));
    return span;
  }

  function doneRow(step, number, animate) {
    // Preserve execution/log indices; only translate participant-facing wording.
    if (String(step.verb).toLowerCase() === 'fill') {
      step = { verb: 'Pour', args: ['water', step.args[0]] };
    }
    var verb = verbForUnity(step.verb);
    var li = document.createElement('li');
    li.className = 'done-row verb-' + (verb ? verb.id : 'other') + (animate ? ' done-new' : '');
    var num = document.createElement('span');
    num.className = 'done-num';
    num.textContent = String(number);
    var verbEl = document.createElement('span');
    verbEl.className = 'done-verb';
    verbEl.textContent = verb ? verb.label : step.verb;
    var what = document.createElement('span');
    what.className = 'done-what';
    step.args.forEach(function (id, k) {
      var p = verb && verb.params[k];
      if (k > 0) {
        var join = document.createElement('span');
        join.className = 'done-join';
        join.textContent = ' ' + (p && p.name === 'target' ? (id === 'maker' ? 'into the' : 'into') : p && p.name === 'location' ? 'at' : '') + ' ';
        what.appendChild(join);
      }
      // Execution uses the source container; describe its contents to participants.
      if (verb && verb.id === 'pour' && k === 0 && id === 'pot' && step.args[1] === 'maker') id = 'water';
      what.appendChild(doneItem(id));
    });
    li.appendChild(num);
    li.appendChild(verbEl);
    li.appendChild(what);
    return li;
  }

  // Rows currently shown, in order (doneKey of each). Used to add only NEW rows (animated) instead of redrawing.
  var doneShown = [];

  function updateDoneCount() {
    var c = $('done-count');
    if (c) c.textContent = doneShown.length ? doneShown.length + (doneShown.length === 1 ? ' step' : ' steps') : '';
  }

  function markLatest() {
    var list = $('done-list');
    Array.prototype.forEach.call(list.querySelectorAll('.done-row.latest'), function (r) { r.classList.remove('latest'); });
    var rows = list.querySelectorAll('.done-row');
    if (rows.length) rows[rows.length - 1].classList.add('latest');
  }

  function appendDone(step, animate) {
    var list = $('done-list');
    var empty = list.querySelector('.done-empty');
    if (empty) empty.remove();
    doneShown.push(doneKey(step));
    list.appendChild(doneRow(step, doneShown.length, animate));
    markLatest();
    updateDoneCount();
    list.scrollTop = list.scrollHeight;   // newest step in view
  }

  // Full list from a checkpoint (source of truth). If what is shown is a prefix of it, only the missing rows are added.
  // Returns the number of valid steps shown, or null when the message has no steps_done (section hidden).
  function renderDone(raw) {
    var area = $('done-area'), list = $('done-list');
    if (!Array.isArray(raw)) { area.hidden = true; return null; }
    var steps = raw.filter(validDoneStep).slice(0, 200);
    var keys = steps.map(doneKey);
    var isPrefix = doneShown.length <= keys.length && doneShown.every(function (k, i) { return k === keys[i]; });
    if (!isPrefix) { doneShown = []; list.textContent = ''; }
    steps.slice(doneShown.length).forEach(function (s) { appendDone(s, isPrefix && doneShown.length > 0); });
    if (!steps.length) {
      list.textContent = '';
      var empty = document.createElement('li');
      empty.className = 'done-empty';
      empty.textContent = 'Nothing yet - the robot is about to start.';
      list.appendChild(empty);
      updateDoneCount();
    }
    area.hidden = false;
    return steps.length;
  }

  // Live: Unity sends one step_done right after the robot finishes each step (never future steps). Add that row now.
  function onUnityStepDone(d) {
    if (!validDoneStep(d.step) || !Number.isInteger(d.done_count) || d.done_count < 1) return;
    if (d.done_count <= doneShown.length) return;   // already shown (repeat or covered by a checkpoint)
    if (doneShown.length >= 200) return;
    $('done-area').hidden = false;
    appendDone(d.step, true);
  }

  function onUnityComplete(d) {
    if (unity.completeSeen) return;
    unity.completeSeen = true;
    tutorialEvent('complete');
    sendToParent({ type: 'run_complete', trial_id: unity.pid, run_log: d.run_log });
    setLocked(true);
    setStatus(d.run_log && d.run_log.run_status === 'aborted'
      ? 'The run was stopped. You can continue.' : 'The robot has finished. You can continue by clicking Next page below.');
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
    var pairOk = tutorialMode ? (variant === 'T1' && drones === '0') : (/^[0-7]$/.test(drones) && /^[LS][1-4]$/.test(variant));
    if (!pairOk) {
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
      recordHistory();
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
      dragKind = 'slot';
      setTimeout(function () { card.classList.add('dragging'); }, 0);
    });
    card.addEventListener('dragend', function () { card.classList.remove('dragging'); clearDropMarks(); });
  }

  // Board mode: the gap where a dragged card / action will land is shown as a bar (class drop-before / drop-after)
  function clearDropMarks() {
    document.querySelectorAll('#timeline .drop-before, #timeline .drop-after, #timeline .over').forEach(function (el) {
      el.classList.remove('drop-before', 'drop-after', 'over');
    });
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
      tutorialEvent('delete');
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
    clearDropMarks();
    dragKind = null;
    var data = readDrag(e);
    if (data && data.from === 'slot' && inputMode === 'board' && editable()) moveCard(data.index, slots.length);   // empty area below the cards = the end
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
  function pickInUnity() { return !!(config && config.pickInUnity && (unity || plantPractice)); }

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

  // 순서 변경: from의 카드를 빼서 insertion 자리(카드 사이 틈의 번호: 0 = 맨 앞, slots.length = 맨 뒤)에 끼운다.
  // 화면에 표시된 틈과 정확히 같은 자리에 들어간다. 자리가 그대로면 아무것도 하지 않는다 (move_count도 세지 않음).
  function moveCard(from, insertion) {
    if (!editable() || from < 0 || from >= slots.length) return;
    var at = insertion > from ? insertion - 1 : insertion;
    if (at < 0) at = 0;
    if (at > slots.length - 1) at = slots.length - 1;
    if (at === from) return;
    var moving = slots.splice(from, 1)[0];
    slots.splice(at, 0, moving);
    metrics.move_count++;
    tutorialEvent('move');
    activeSlot = null;
    insertAfter = null;
    render();
  }

  // What is being dragged right now ('slot' | 'verb' | 'tile'). dataTransfer cannot be read during dragover.
  var dragKind = null;

  // Pointer in the upper half of a card = the gap before it, lower half = the gap after it
  function dropHalf(slot, e) {
    var r = slot.getBoundingClientRect();
    return typeof e.clientY === 'number' && e.clientY > r.top + r.height / 2 ? 'after' : 'before';
  }

  function renderBoardTimeline(tl) {
    var groups = boardGroups();
    groups.forEach(function (g, gi) {
      var slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.slot = g.start;
      slot.dataset.len = g.len;
      slot.appendChild(buildBoardCard(g, gi));
      slot.addEventListener('dragover', function (e) {
        e.preventDefault();
        clearDropMarks();
        // a picture fills the current blank (no gap); cards and actions show the gap they will land in
        if (dragKind === 'tile') slot.classList.add('over');
        else slot.classList.add(dropHalf(slot, e) === 'after' ? 'drop-after' : 'drop-before');
      });
      slot.addEventListener('dragleave', function (e) {
        if (e.relatedTarget && slot.contains(e.relatedTarget)) return;
        slot.classList.remove('over', 'drop-before', 'drop-after');
      });
      slot.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var at = g.start + (dropHalf(slot, e) === 'after' ? g.len : 0);
        clearDropMarks();
        dragKind = null;
        var data = readDrag(e);
        if (!editable() || !data) return;
        if (data.from === 'slot') moveCard(data.index, at);
        else if (data.from === 'verb') addVerbStep(data.id, at);
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
    clearPickNote();
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
    revealStep(at);
    tutorialEvent('card:' + verbId);
  }

  // Scroll the plan list (only the list, never the page) so card i is fully visible above the action chips.
  function revealStep(i) {
    var tl = $('timeline'), row = tl.querySelectorAll('.step-row')[i];
    if (!row) return;
    var top = row.getBoundingClientRect().top - tl.getBoundingClientRect().top + tl.scrollTop;
    var bottom = top + row.offsetHeight;
    if (bottom > tl.scrollTop + tl.clientHeight) tl.scrollTop = bottom - tl.clientHeight + 8;
    else if (top < tl.scrollTop) tl.scrollTop = Math.max(0, top - 8);
  }

  function fillSlot(target, key, alias) {
    if (!editable() || !accepts(target, key)) return false;
    var item = slots[target.index];
    item.params[target.param] = conceptIdFor(key, paramOf(target.index, target.param));
    // alias = the word the participant picked (e.g. "water"); the stored id stays the real one (pot), so scoring is unchanged
    if (item.alias) delete item.alias[target.param];
    if (alias) { item.alias = item.alias || {}; item.alias[target.param] = alias; }
    clearPickNote();
    metrics.param_change_count++;
    tutorialEvent('pick:' + conceptKey(key));
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

  // ---------- "Can't find it in the scene? Search by name" (pickInUnity mode) ----------
  // A small search box in the corner of the scene. It searches the WHOLE vocabulary (every item and place, plus synonyms in
  // vocab.aliases), the same in every variant and checkpoint, so it does not hint at the task. Results need 2+ letters and show
  // at most 6 (no full list). Picking a result stores the real id (auto-scored). Only when nothing matches: "+ Add '<text>'
  // as a new item" stores custom:<text> (scored as a mismatch, logged for manual coding).
  // An alias stores its real id (water -> pot); the card shows the word the participant picked ("Water").
  var SEARCH_MAX = 6, CUSTOM_MAX = 40;
  function aliasFor(key) { return (vocab.aliases && vocab.aliases[key]) || null; }
  function aliasFits(target, a) {
    if (!target) return false;
    if (a.verbs && a.verbs.indexOf(slots[target.index].verb) === -1) return false;
    return !a.param || a.param === target.param;
  }
  function isCustom(id) { return typeof id === 'string' && id.indexOf('custom:') === 0; }
  // what a filled blank shows: the alias word if one was used, the typed text for a custom item, else the normal label
  function shownLabel(item, paramName, val) {
    var k = item.alias && item.alias[paramName], a = k && aliasFor(k);
    if (a && val && conceptKey(a.id) === conceptKey(val)) return a.label;
    if (isCustom(val)) return val.slice(7);
    return labelFor(val);
  }
  // Clicking e.g. the sink on a Pour blank: a neutral pointer to the search (no answer in the text)
  function clickHint(key, target) {
    var aliases = vocab.aliases || {};
    for (var k in aliases) {
      var a = aliases[k];
      if ((a.hintWhenClicked || []).indexOf(key) !== -1 && aliasFits(target, a) && a.hint) return a.hint;
    }
    return null;
  }
  function searchEntries() {
    var out = boardItems().map(function (o) { return { key: o.id, label: o.label, id: o.id, alias: null }; });
    Object.keys(vocab.aliases || {}).forEach(function (k) {
      var a = vocab.aliases[k];
      out.push({ key: k, label: a.label, id: a.id, alias: k });
    });
    return out;
  }
  function searchMatches(q) {
    q = q.trim().toLowerCase();
    if (q.length < 2) return [];
    var hits = searchEntries().filter(function (e) { return e.label.toLowerCase().indexOf(q) !== -1; });
    hits.sort(function (x, y) {
      var a = x.label.toLowerCase().indexOf(q) === 0 ? 0 : 1, b = y.label.toLowerCase().indexOf(q) === 0 ? 0 : 1;
      return a - b || (x.label.toLowerCase() < y.label.toLowerCase() ? -1 : 1);
    });
    return hits.slice(0, SEARCH_MAX);
  }
  function entryFits(target, e) {
    if (!target) return false;
    var a = e.alias && aliasFor(e.alias);
    return a ? aliasFits(target, a) && accepts(target, a.id) : accepts(target, e.id);
  }
  function cleanCustom(text) { return String(text).replace(/\s+/g, ' ').trim().slice(0, CUSTOM_MAX); }

  var find = { open: false, hi: 0, logTimer: null };
  function findLog(type, data) { if (studyLog) studyLog.record(type, data); }
  function closeFind() {
    var box = $('find-box');
    find.open = false;
    if (!box) return;
    box.classList.remove('open');
    $('find-input').value = '';
    renderFindResults();
  }
  function openFind() {
    find.open = true; find.hi = 0;
    $('find-box').classList.add('open');
    renderFindResults();
    $('find-input').focus();
    findLog('item_search_open', { target: currentTarget() });
  }
  function pickFind(e, query) {
    var target = currentTarget();
    var data = { id: e ? e.id : null, query: query, source: 'search', alias: e && e.alias ? e.alias : null, custom: !e };
    findLog('item_pick_attempt', { id: data.id, editable: editable(), target: target, source: 'search', query: query });
    function done(result) { data.result = result; findLog('item_pick_result', data); }
    if (!editable() || confirmOpen) { done('not_editable'); return; }
    if (!target) { done('no_target'); pickNote('Choose an action below first, then search.'); return; }
    if (e) {
      if (!entryFits(target, e) || !fillSlot(target, e.id, e.alias)) {
        done('incompatible_item');
        pickNote(e.label + ' does not fit step ' + (target.index + 1) + ' (' + verbsById[slots[target.index].verb].label + ').');
        return;
      }
    } else {
      var text = cleanCustom(query);
      if (text.length < 2) { done('too_short'); return; }
      data.id = 'custom:' + text;
      fillCustom(target, text);
    }
    done('accepted');
    markFirstDrag();
    closeFind();
  }
  // A participant-typed item: stored as custom:<text> (no vocabulary check; it never matches the truth automatically)
  function fillCustom(target, text) {
    var item = slots[target.index];
    item.params[target.param] = 'custom:' + text;
    if (item.alias) delete item.alias[target.param];
    clearPickNote();
    metrics.param_change_count++;
    metrics.custom_item_count = (metrics.custom_item_count || 0) + 1;
    var next = firstEmpty(target.index);
    activeSlot = next ? { index: target.index, param: next } : null;
    render();
  }
  function renderFindResults() {
    var list = $('find-results');
    if (!list) return;
    var q = $('find-input').value, target = currentTarget();
    list.textContent = '';
    if (!find.open) return;
    var hits = q.trim().length >= 2 ? searchMatches(q) : [];
    var note = document.createElement('li');
    note.className = 'find-note';
    if (!target) note.textContent = 'First choose an action below.';
    else if (q.trim().length < 2) note.textContent = 'Type at least 2 letters.';
    if (note.textContent) list.appendChild(note);
    var enabled = [];
    hits.forEach(function (e) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'find-hit';
      b.dataset.key = e.key;
      b.textContent = e.label;
      b.disabled = !editable() || !entryFits(target, e);
      if (!b.disabled) enabled.push(b);
      b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });   // keep the input focused
      b.addEventListener('click', function () { pickFind(e, q); });
      li.appendChild(b);
      list.appendChild(li);
    });
    if (target && q.trim().length >= 2 && !hits.length) {
      var li2 = document.createElement('li');
      var add = document.createElement('button');
      add.type = 'button';
      add.className = 'find-hit find-add';
      add.textContent = '+ Add "' + cleanCustom(q) + '" as a new item';
      add.disabled = !editable();
      if (!add.disabled) enabled.push(add);
      add.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
      add.addEventListener('click', function () { pickFind(null, q); });
      li2.appendChild(add);
      list.appendChild(li2);
    }
    if (find.hi >= enabled.length) find.hi = 0;
    enabled.forEach(function (b, i) { b.classList.toggle('hi', i === find.hi); });
  }
  function renderOffScene(target) {
    var box = $('find-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'find-box';
      box.innerHTML = '<button type="button" id="find-open"></button>' +
        '<div class="find-panel"><ul id="find-results" role="listbox"></ul>' +
        '<div class="find-row"><input id="find-input" type="text" autocomplete="off" spellcheck="false" maxlength="40" aria-label="Search by name">' +
        '<button type="button" id="find-close" aria-label="Close">&times;</button></div></div>';
      box.querySelector('#find-open').textContent = "Can't find it in the scene? Search by name";
      box.querySelector('#find-input').placeholder = 'Type an item or place…';
      box.querySelector('#find-open').addEventListener('click', openFind);
      box.querySelector('#find-close').addEventListener('click', closeFind);
      var input = box.querySelector('#find-input');
      input.addEventListener('input', function () {
        find.hi = 0;
        renderFindResults();
        clearTimeout(find.logTimer);
        var q = input.value;
        find.logTimer = setTimeout(function () {   // what people search for (incl. zero-hit words): to grow the vocabulary
          if (q.trim().length >= 2) findLog('item_search', { query: q.trim(), results: searchMatches(q).length });
        }, 700);
      });
      input.addEventListener('keydown', function (e) {
        var btns = Array.prototype.filter.call($('find-results').querySelectorAll('.find-hit'), function (b) { return !b.disabled; });
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (btns.length) { find.hi = (find.hi + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length; renderFindResults(); }
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (btns[find.hi]) btns[find.hi].click();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeFind();
        }
      });
    }
    if (box.parentNode !== $('unity-area')) $('unity-area').appendChild(box);   // floats over the bottom-right corner of the scene
    box.hidden = !pickInUnity();
    box.classList.toggle('open', find.open);
    $('find-open').disabled = !editable();
    if (!editable() && find.open) closeFind();
    renderFindResults();
  }

  function buildSlotButton(index, param) {
    var item = slots[index];
    var val = item.params[param.name];
    var t = currentTarget();
    var target = { index: index, param: param.name };
    var isActive = !!(activeSlot && activeSlot.index === index && activeSlot.param === param.name && !val);
    var control = document.createElement('div');
    control.className = 'slot-control';
    var controlInput;
    if (isActive) {
      // Replace the placeholder itself with the search field.
      controlInput = document.createElement('input');
      controlInput.type = 'search';
      controlInput.className = 'slot-btn slot-inline-search active';
      controlInput.placeholder = 'Search…';
      controlInput.setAttribute('aria-label', 'Search ' + param.label + ' by name');
      controlInput.autocomplete = 'off';
    } else {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot-btn' + (val ? '' : ' empty') + (t && t.index === index && t.param === param.name ? ' active' : '');
      btn.dataset.param = param.name;
      if (val) {
        var nm = document.createElement('span');
        nm.textContent = shownLabel(item, param.name, val);
        btn.appendChild(nm);
        btn.title = 'Click to change';
      } else btn.textContent = param.hint || ('Which ' + param.label + '?');
      btn.addEventListener('click', function () {
        if (!editable()) return;
        if (item.params[param.name]) { item.params[param.name] = ''; metrics.param_change_count++; }
        activeSlot = target;
        render();
        var field = document.querySelector('.slot-inline-search');
        if (field) { field.focus(); field.dispatchEvent(new Event('focus')); }
      });
      btn.addEventListener('dragover', function (e) { e.preventDefault(); });
      btn.addEventListener('drop', function (e) {
      var data = readDrag(e);
      if (!data || data.from !== 'tile') return;
      e.preventDefault();
      e.stopPropagation();
      fillSlot(target, data.id);
      });
      controlInput = btn;
    }
    control.appendChild(controlInput);
    if (isActive) {
      var results = document.createElement('div');
      results.className = 'slot-search-results slot-search-portal';
      results.setAttribute('role', 'listbox');
      function updateSearch() {
        results.textContent = '';
        var query = controlInput.value.trim();
        results.hidden = !query;
        $('plan-box').classList.toggle('slot-search-open', !!query);
        if (!query) return;
        var entries = searchEntries().filter(function (entry) { return entryFits(target, entry); });
        entries = entries.filter(function (entry) { return entry.label.toLowerCase().indexOf(query.toLowerCase()) !== -1; });
        entries.sort(function (a, b) { return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }); });
        entries.slice(0, SEARCH_MAX).forEach(function (entry) {
          var option = document.createElement('button');
          option.type = 'button';
          option.setAttribute('role', 'option');
          option.textContent = entry.label;
          option.addEventListener('mousedown', function (event) { event.preventDefault(); });
          option.addEventListener('click', function () { fillSlot(target, entry.id, entry.alias); });
          results.appendChild(option);
        });
        if (!entries.length) {
          var custom = document.createElement('button');
          custom.type = 'button';
          custom.textContent = 'Use “' + cleanCustom(query) + '”';
          custom.addEventListener('mousedown', function (event) { event.preventDefault(); });
          custom.addEventListener('click', function () { fillCustom(target, query); });
          results.appendChild(custom);
        }
        positionSlotSearch(results, controlInput);
      }
      controlInput.addEventListener('input', updateSearch);
      controlInput.addEventListener('focus', updateSearch);
      controlInput.addEventListener('click', function (event) { event.stopPropagation(); });
      controlInput.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') { event.preventDefault(); activeSlot = null; render(); }
      });
      document.body.appendChild(results);
      results._slotAnchor = controlInput;
      updateSearch();
    }
    return control;
  }

  function positionSlotSearch(search, anchor) {
    var rect = anchor.getBoundingClientRect();
    var width = Math.min(Math.max(220, rect.width), window.innerWidth - 16);
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    search.style.width = width + 'px';
    search.style.left = left + 'px';
    // Keep the input and results inside the viewport, opening upward near the bottom.
    var estimatedHeight = Math.min(220, search.scrollHeight || 220);
    var top = rect.bottom + 6;
    if (top + estimatedHeight > window.innerHeight - 8 && rect.top > estimatedHeight) {
      top = rect.top - estimatedHeight - 6;
    }
    search.style.top = Math.max(8, Math.min(top, window.innerHeight - 120)) + 'px';
  }

  // 카드 한 장: 머리줄(번호 · 동작 · ×) + 대상 칸들 (한 줄에 하나씩, 두 번째 칸 앞에는 연결어)
  function buildStepRow(index) {
    var item = slots[index];
    var verb = verbsById[item.verb];
    var row = document.createElement('div');
    row.className = 'step-row' + (isItemComplete(item) ? '' : ' needs-action');
    var head = document.createElement('div');
    head.className = 'step-head';
    var grip = document.createElement('span');
    grip.className = 'step-grip';   // drag handle (the whole card stays draggable)
    grip.setAttribute('aria-hidden', 'true');
    grip.title = 'Drag to move';
    head.appendChild(grip);
    var num = document.createElement('span');
    num.className = 'step-num';
    num.textContent = String(index + 1);   // 전체 계획에서의 단계 번호
    head.appendChild(num);
    var v = document.createElement('span');
    v.className = 'step-verb';
    v.dataset.verb = verb.id;   // same color as the action chip and the "done so far" tag
    v.textContent = verb.label;
    head.appendChild(v);
    // Up/Down: the simple alternative to dragging (disabled at the ends)
    var moves = document.createElement('span');
    moves.className = 'step-move';
    [['move-up', '↑', 'Move step up', index - 1, index === 0],
     ['move-down', '↓', 'Move step down', index + 2, index === slots.length - 1]].forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'move-btn ' + m[0];
      b.textContent = m[1];
      b.setAttribute('aria-label', m[2]);
      b.title = m[2];
      b.disabled = m[4];
      b.addEventListener('click', function () { closePicker(); moveCard(index, m[3]); });
      moves.appendChild(b);
    });
    head.appendChild(moves);
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
      ? 'First choose an action below, then ' + where + ' to fill it in.'
      : target
        ? (inUnity ? 'Click an object in the simulation for step ' : 'Tap a picture for step ') + (target.index + 1) + ' (' + verbsById[slots[target.index].verb].label + ')' + (inUnity ? '.' : ', or drag it onto a blank.')
        : insertAfter !== null
          ? 'The next action will be added after step ' + (insertAfter + 1) + '. Click + again to add at the end.'
          : 'Drag cards or use the arrows to change the order.';
    var grid = $('places-grid');
    grid.textContent = '';
    grid.hidden = inUnity;   // Unity에서 고르면 그림 타일은 숨긴다
    document.querySelectorAll('#verb-bar .verb-chip').forEach(function (c) { c.disabled = !editable() || isFull(); });
    renderOffScene(target);
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
        dragKind = 'tile';
      });
      grid.appendChild(btn);
    });
  }

  function renderVerbBar() {
    var bar = document.createElement('div');
    bar.id = 'verb-bar';
    var cap = document.createElement('span');
    cap.className = 'verb-bar-label';
    cap.textContent = '+ Add step:';
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
        dragKind = 'verb';
      });
      bar.appendChild(b);
    });
    // The chips live INSIDE the plan box, right under the last card (where a new card appears).
    // #plan-box = dashed box: the card list (#timeline, scrolls) + the chips (always visible at the bottom when the list is long).
    var box = document.createElement('div');
    box.id = 'plan-box';
    $('timeline-area').insertBefore(box, $('timeline'));
    box.appendChild($('timeline'));
    box.appendChild(bar);
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
    document.querySelectorAll('.slot-search-portal').forEach(function (menu) { menu.remove(); });
    var planBox = $('plan-box');
    if (planBox) planBox.classList.remove('slot-search-open');
    if (studyLog) studyLog.plan(buildResponse());
    recordHistory();
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
    updateHistoryButtons();
    if (coach) coach.paint();
    // Position portal menus only after their anchor buttons have entered layout.
    document.querySelectorAll('.slot-search-portal').forEach(function (menu) {
      if (menu._slotAnchor && menu._slotAnchor.isConnected) positionSlotSearch(menu, menu._slotAnchor);
    });
  }

  function buildGhost(i) {
    var ghost = document.createElement('div');
    ghost.className = 'slot empty';
    var inner = document.createElement('div');
    inner.className = 'ghost';
    // A quiet text hint, not a button: it only marks the end of the plan (drop target for "move to the end").
    // Clicking it is not a dead end: it briefly highlights the action chips where steps are added.
    if (i === 0) {
      ghost.classList.add('start');
      inner.textContent = 'Choose an action below to start your plan';
    } else {
      // The chips are right below, so the end marker has no text: it is only a thin drop target (move to the end).
      inner.textContent = isFull() ? 'Step limit reached' : '';
      if (!isFull()) ghost.classList.add('end');
    }
    ghost.appendChild(inner);
    ghost.addEventListener('click', pulseVerbBar);
    ghost.addEventListener('dragover', function (e) {
      e.preventDefault();
      clearDropMarks();
      ghost.classList.add(dragKind === 'tile' ? 'over' : 'drop-before');
    });
    ghost.addEventListener('dragleave', function (e) {
      if (e.relatedTarget && ghost.contains(e.relatedTarget)) return;
      ghost.classList.remove('over', 'drop-before');
    });
    ghost.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      clearDropMarks();
      dragKind = null;
      var data = readDrag(e);
      if (!editable() || !data) return;
      if (data.from === 'slot') moveCard(data.index, slots.length);
      else if (data.from === 'verb') addVerbStep(data.id, slots.length);
      else if (data.from === 'tile') fillFromTile(data.id);
    });
    return ghost;
  }

  var pulseTimer = null;
  function pulseVerbBar() {
    var bar = $('verb-bar');
    if (!bar || !editable()) return;
    bar.classList.remove('pulse');
    void bar.offsetWidth;   // restart the animation on repeated clicks
    bar.classList.add('pulse');
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(function () { bar.classList.remove('pulse'); }, 1200);
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
    fetch('config/config.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }),
    tutorialMode ? fetch('config/tutorial.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }) : Promise.resolve(null)
  ]).then(function (res) {
    vocab = res[0];
    if (plantPractice) {
      vocab.pools = {locations:['plant','brown_table','lamp'], objects:['plant'], surfaces:['brown_table'], devices:['lamp']};
      vocab.labels = {plant:'Plant',brown_table:'Brown table',lamp:'Lamp'};
      vocab.aliases = {}; vocab.images = {}; vocab.rules = {};
    }
    tutorialCfg = res[2];
    if (tutorialCfg) applyVocabOverlay(vocab, tutorialCfg.vocabOverlay || {});
    allVerbs = vocab.verbs.slice();
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

    $('submit-btn').addEventListener('click', openConfirm);
    $('confirm-yes').addEventListener('click', confirmSubmit);
    $('confirm-back').addEventListener('click', function () { closeConfirm(true); });
    $('undo-btn').addEventListener('click', undo);
    $('redo-btn').addEventListener('click', redo);
    $('picker-cancel').addEventListener('click', closePicker);
    document.addEventListener('keydown', function (e) {
      if (confirmOpen) {
        if (e.key === 'Escape') { e.preventDefault(); closeConfirm(true); }
        else if (e.key === 'Tab') {   // keep focus inside the dialog
          var a = $('confirm-back'), b = $('confirm-yes');
          e.preventDefault();
          (document.activeElement === a ? b : a).focus();
        }
        return;
      }
      if (e.key === 'Escape' && picker) closePicker();
      var k = String(e.key).toLowerCase();
      if (e.target && e.target.id === 'find-input') return;   // typing in the search box: no plan undo/redo
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === 'z' || k === 'y')) {
        e.preventDefault();
        if (k === 'y' || e.shiftKey) redo(); else undo();
      }
    });
    document.addEventListener('dragend', function () { dragKind = null; clearDropMarks(); });
    // 캡처 단계에서 세므로 Submit 클릭도 포함된다
    $('toolbox').addEventListener('click', countClick, true);
    $('timeline-area').addEventListener('click', countClick, true);
    var tl = $('timeline');
    tl.addEventListener('dragover', function (e) { e.preventDefault(); });
    tl.addEventListener('drop', onDropTimeline);
    renderToolbox();

    var pid = q.get('pid'), drones = q.get('drones'), variant = q.get('variant');
    if (plantPractice) openPlantRoom();
    else if (config.unityUrl && pid && drones !== null && variant) {
      setupUnity(q);
      if (inputMode === 'board') render();   // Unity가 연결됐으니 대기 화면에서도 그림 타일을 숨긴다 (Unity에서 고르는 방식)
    } else if (config.devMode && q.has('n')) {
      // 개발 모드에서만: 체크포인트 없이 ?n=3 으로 바로 시작
      startTrial(getN(), false);
      render();
      $('panel').hidden = false;
    }
    if (!plantPractice) studyLog = window.createStudyLog(sendToParent, function () {
      return {trial_id: unity ? unity.pid : trial.trial_id, checkpoint_id: unity && unity.cp ? 'cp' + unity.cp.index : trial.checkpoint_id,
        qualtrics_response_id: new URLSearchParams(location.search).get('response_id') || ''};
    });
    window.studyLog = studyLog; // researcher-only console export: studyLog.download()
    if (tutorialMode && tutorialCfg && !coach) coach = createCoach(tutorialCfg);
    if (studyLog && metrics && !submitted) studyLog.begin(buildResponse());
    ready = true;
    pendingMessages.splice(0).forEach(routeMessage);
    // 시작 조건(Unity 파라미터 또는 부모의 checkpoint)을 못 받으면 빈 화면 대신 안내를 보여 준다
    setTimeout(function () { if ($('panel').hidden) $('idle-note').hidden = false; }, 1500);
  });
  // ---------- Tutorial coach (UI practice, ?tutorial=1) ----------
  // One instruction at a time (config/tutorial.json "steps"). A step is done when all its "needs" events have happened since it was
  // shown (any order; repeats count separately, e.g. two "move"). Events come from the existing actions (tutorialEvent calls).
  // Submit is only possible at a step that needs "submit". "Show me" appears after hintAfterMs without progress.
  function tutorialEvent(name) { if (coach) coach.event(name); }

  // tutorial.json "vocabOverlay": adds pool entries and widens EXISTING rules only (never adds a restriction the study does not have)
  function applyVocabOverlay(v, ov) {
    Object.keys(ov.pools || {}).forEach(function (pool) {
      v.pools[pool] = v.pools[pool] || [];
      ov.pools[pool].forEach(function (id) { if (v.pools[pool].indexOf(id) === -1) v.pools[pool].push(id); });
    });
    Object.keys(ov.labels || {}).forEach(function (id) { v.labels = v.labels || {}; v.labels[id] = ov.labels[id]; });
    Object.keys(ov.rules || {}).forEach(function (verb) {
      Object.keys(ov.rules[verb]).forEach(function (param) {
        var base = v.rules && v.rules[verb] && v.rules[verb][param];
        if (!base || !base.allow) return;   // no allow-list in the study: nothing to widen
        var add = ov.rules[verb][param].allow;
        if (Array.isArray(base.allow) && Array.isArray(add)) add.forEach(function (id) { if (base.allow.indexOf(id) === -1) base.allow.push(id); });
        else if (!Array.isArray(base.allow) && add && !Array.isArray(add)) Object.keys(add).forEach(function (k) { base.allow[k] = add[k]; });
      });
    });
  }

  function createCoach(cfg) {
    var box = document.createElement('div');
    box.id = 'coach';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    $('status-bar').parentNode.insertBefore(box, $('status-bar').nextSibling);
    document.body.classList.add('tutorial');
    var steps = cfg.steps || [], k = -1, need = [], shownAt = 0, lastProgress = 0, hintTimer = null, mode = 'intro';
    var hintMs = parseInt(new URLSearchParams(location.search).get('hint_ms'), 10) || cfg.hintAfterMs || 20000;
    var api = {};
    function cur() { return steps[k] || null; }
    function draw() {
      box.textContent = '';
      var head = document.createElement('div');
      head.className = 'coach-head';
      var text = document.createElement('p');
      text.className = 'coach-text';
      if (mode === 'step') {
        head.textContent = 'Practice · Step ' + (k + 1) + ' of ' + steps.length;
        text.textContent = cur().text;
      } else {
        head.textContent = 'Practice';
        text.textContent = mode === 'intro' ? cfg.intro : mode === 'waiting' ? cfg.waiting : cfg.done;
      }
      box.appendChild(head);
      box.appendChild(text);
      if (mode === 'step' && cur().hint) {
        var show = document.createElement('button');
        show.type = 'button';
        show.id = 'coach-show';
        show.textContent = 'Show me';
        show.hidden = true;
        var hint = document.createElement('p');
        hint.className = 'coach-hint';
        hint.hidden = true;
        hint.textContent = cur().hint;
        show.addEventListener('click', function () {
          hint.hidden = false; show.hidden = true;
          pulseTargets();
          if (studyLog) studyLog.record('tutorial_hint_used', { step: k + 1 });
        });
        box.appendChild(show);
        box.appendChild(hint);
      }
      box.dataset.step = mode === 'step' ? String(k + 1) : mode;
      api.paint();
    }
    function armHint() {
      clearTimeout(hintTimer);
      if (mode !== 'step' || !cur().hint) return;
      hintTimer = setTimeout(function () { var b = $('coach-show'); if (b && $('coach').dataset.step === String(k + 1)) b.hidden = false; }, hintMs);
    }
    function pulseTargets() {
      document.querySelectorAll('.coach-target').forEach(function (el) {
        el.classList.remove('coach-pulse'); void el.offsetWidth; el.classList.add('coach-pulse');
      });
    }
    function show(i) {
      k = i; mode = 'step';
      need = (cur().needs || []).slice();
      shownAt = lastProgress = performance.now();
      if (studyLog) studyLog.record('tutorial_step_shown', { step: k + 1 });
      draw();
      armHint();
    }
    function finishStep() {
      if (studyLog) studyLog.record('tutorial_step_done', { step: k + 1, ms: Math.round(performance.now() - shownAt) });
      var next = k + 1;
      if (next >= steps.length) { mode = 'waiting'; draw(); return; }
      if (steps[next].atCheckpoint && !api.checkpointSeen(steps[next].atCheckpoint)) { mode = 'waiting'; k = next - 1; draw(); return; }
      show(next);
    }
    var cpSeen = {};
    api.checkpointSeen = function (n) { return !!cpSeen[n]; };
    api.event = function (name) {
      var m = /^checkpoint:(\d+)$/.exec(name);
      if (m) {
        cpSeen[m[1]] = true;
        var nextIdx = mode === 'waiting' ? k + 1 : -1;
        if (mode === 'intro' && m[1] === '1') show(0);
        else if (nextIdx >= 0 && steps[nextIdx] && String(steps[nextIdx].atCheckpoint) === m[1]) show(nextIdx);
        return;
      }
      if (name === 'complete') { mode = 'done'; clearTimeout(hintTimer); draw(); return; }
      if (mode !== 'step') return;
      var i = need.indexOf(name);
      if (i === -1) return;
      need.splice(i, 1);
      lastProgress = performance.now();
      armHint();
      if (!need.length) finishStep();
    };
    api.allowSubmit = function () { return mode === 'step' && (cur().needs || []).indexOf('submit') !== -1 && need.length === 1 && need[0] === 'submit'; };
    api.nudge = function () {
      var t = box.querySelector('.coach-text');
      if (t) { t.classList.remove('coach-shake'); void t.offsetWidth; t.classList.add('coach-shake'); }
      pulseTargets();
      if (studyLog) studyLog.record('tutorial_submit_blocked', { step: mode === 'step' ? k + 1 : null });
    };
    api.paint = function () {
      document.querySelectorAll('.coach-target').forEach(function (el) { el.classList.remove('coach-target'); });
      if (mode !== 'step' || !cur().target) return;
      document.querySelectorAll(cur().target).forEach(function (el) { el.classList.add('coach-target'); });
    };
    draw();
    return api;
  }
})();
