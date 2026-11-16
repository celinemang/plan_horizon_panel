/* Event times are monotonic milliseconds; visibility is not a measure of attention. */
(function (root) {
  'use strict';
  root.createStudyLog = function (send, context) {
    var start = performance.now(), seq = 0, pending = [], events = [];
    var run = (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
    var seen = Object.create(null), storageKey = 'hri-panel-outbox:' + run;
    function persist() {
      try { root.localStorage.setItem(storageKey, JSON.stringify(pending)); return true; }
      catch (err) { return false; }
    }
    // Recover only the SAME Qualtrics response. Never attach another response's outbox.
    try {
      var responseId = context().qualtrics_response_id, recoveredKeys = [];
      if (responseId) {
        for (var k = 0; k < root.localStorage.length; k++) {
          var key = root.localStorage.key(k);
          if (!key || key === storageKey || key.indexOf('hri-panel-outbox:') !== 0) continue;
          var old = JSON.parse(root.localStorage.getItem(key));
          if (Array.isArray(old) && old.length && old.every(function (e) { return e.qualtrics_response_id === responseId; })) {
            pending = pending.concat(old); recoveredKeys.push(key);
          }
        }
        if (persist()) recoveredKeys.forEach(function (key) { root.localStorage.removeItem(key); });
      }
    } catch (err) {}
    var taskStart = null;
    var cpStart = null, visibleStart = null, visibleMs = 0, firstEdit = null, previous = null, initial = null;
    function flush() {
      if (!pending.length) return;
      persist();
      send({type: 'study_log', schema_version: 1, run_id: run, events: pending.slice()});
    }
    function record(type, data) {
      var sourceId = data && data.event_id;
      if (sourceId && seen[sourceId]) { flush(); return persist(); }
      if (type === 'unity_ready' && taskStart === null) taskStart = performance.now();
      if (type === 'unity_run_complete') data = Object.assign({}, data, {task_wall_ms: taskStart === null ? null : Math.round(performance.now() - taskStart)});
      var event = Object.assign({schema_version: 1, seq: ++seq, run_id: run, utc: new Date().toISOString(), elapsed_ms: Math.round(performance.now() - start), type: type}, context(), {data: data || {}});
      event.event_id = sourceId || run + ':' + seq;
      if (sourceId) seen[sourceId] = true;
      events.push(event); pending.push(event);
      var stored = persist();
      send({type: 'study_log', schema_version: 1, run_id: run, events: [event]});
      return stored;
    }
    function visibleDuration() { return Math.round(visibleMs + (visibleStart === null ? 0 : performance.now() - visibleStart)); }
    var api = {
      record: record, flush: flush,
      acknowledge: function (ids) {
        pending = pending.filter(function (e) { return ids.indexOf(e.event_id) === -1; });
        persist();
      },
      begin: function (plan) {
        cpStart = performance.now(); visibleMs = 0; visibleStart = document.hidden ? null : cpStart; firstEdit = null;
        previous = initial = JSON.stringify(plan);
        record('checkpoint_open', {initial_plan: plan});
      },
      plan: function (plan) {
        var next = JSON.stringify(plan);
        if (cpStart === null || next === previous) return;
        if (firstEdit === null) firstEdit = Math.round(performance.now() - cpStart);
        record('plan_changed', {before: JSON.parse(previous), after: plan}); previous = next;
      },
      submit: function (plan) {
        api.plan(plan);
        var timing = {writing_wall_ms: Math.round(performance.now() - cpStart), writing_visible_ms: visibleDuration(), first_edit_ms: firstEdit, changed_from_initial: JSON.stringify(plan) !== initial};
        record('checkpoint_submit', {plan: plan, timing: timing}); cpStart = null; visibleStart = null;
        return timing;
      },
      download: function () {
        var blob = new Blob([events.map(function (e) {return JSON.stringify(e);}).join('\n') + '\n'], {type: 'application/x-ndjson'});
        var url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'study-' + run + '.jsonl'; a.click(); setTimeout(function () {URL.revokeObjectURL(url);}, 1000);
      }
    };
    document.addEventListener('visibilitychange', function () {
      if (cpStart !== null) {
        if (visibleStart !== null) visibleMs += performance.now() - visibleStart;
        visibleStart = document.hidden ? null : performance.now();
      }
      record('visibility', {hidden: document.hidden});
    });
    root.addEventListener('pagehide', function () {record('pagehide');});
    if (root.setInterval) root.setInterval(flush, 2000);
    ['click', 'change', 'dragstart', 'drop'].forEach(function (type) {
      document.addEventListener(type, function (e) {
        var el = e.target.closest && e.target.closest('button,select,[data-id],[data-verb],[data-slot]');
        if (!el) return;
        var slot = el.closest('[data-slot]');
        record('ui_' + type, {element: el.id || el.className, item_id: el.dataset.id || null, verb: el.dataset.verb || null, param: el.dataset.param || null, slot: slot ? slot.dataset.slot : null, value: el.tagName === 'SELECT' ? el.value : null, label: (el.textContent || '').slice(0,100)});
      }, true);
    });
    record('panel_open', {width: root.innerWidth, height: root.innerHeight});
    return api;
  };
})(window);
