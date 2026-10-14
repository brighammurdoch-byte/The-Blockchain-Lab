/**
 * In-browser 51% races for the classroom simulator page.
 *
 * Each next block is found by the attacker with probability equal to their
 * hash share (Math.random, or a seedable RNG). Nothing forces a win or a loss.
 *
 * Fork choice is the live hub: RelayBlockchainState.tryAddBlock and
 * _selectBestChain. The hub rejects a parent more than STALE_PARENT_LIMIT
 * blocks behind the tip, so a private chain one past that is finished.
 */
(function (global) {
  'use strict';

  /** Matches tryAddBlock: `tipIndex - parentIndex > STALE_PARENT_LIMIT`. */
  var STALE_PARENT_LIMIT = (function () {
    var Relay = global.RelayBlockchainState;
    var n = Relay && Number(Relay.STALE_PARENT_LIMIT);
    return (isFinite(n) && n >= 0) ? n : 10;
  })();
  var STALE_GAP = STALE_PARENT_LIMIT + 1;
  /** Tiny proof-of-work so each simulated block's hash is a real digest. */
  var SIM_LEADING = 1;
  var SIM_SECONDARY = 15;

  function getRelay(opts) {
    if (opts && opts.Relay) return opts.Relay;
    if (global.RelayBlockchainState) return global.RelayBlockchainState;
    throw new Error('RelayBlockchainState is not loaded');
  }

  function hashSeed(text) {
    var h = 2166136261;
    var s = String(text);
    var i;
    for (i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /**
   * Blank seed → Math.random. Any other seed → a 32-bit LCG so the same seed
   * replays the same sequence of block winners and waits.
   */
  function createRng(seed) {
    var raw = seed == null ? '' : String(seed).trim();
    var rnd;
    if (!raw) {
      rnd = function () { return Math.random(); };
      rnd.seeded = false;
      rnd.label = '';
      return rnd;
    }
    var asNumber = Number(raw);
    var state = (isFinite(asNumber) && String(asNumber) === raw)
      ? (Math.abs(Math.floor(asNumber)) >>> 0)
      : hashSeed(raw);
    if (state === 0) state = 1;
    rnd = function () {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    rnd.seeded = true;
    rnd.label = raw;
    return rnd;
  }

  function parseShares(text) {
    var parts = String(text == null ? '' : text).split(/[,;\s]+/).filter(Boolean);
    if (!parts.length) {
      throw new Error('Enter at least one hash share, such as 30, 45, 55, 70.');
    }
    if (parts.length > 12) {
      throw new Error('Use at most 12 shares in one run.');
    }
    var nums = parts.map(function (part) {
      var n = Number(part);
      if (!isFinite(n)) throw new Error('“' + part + '” is not a number.');
      return n;
    });
    var asFraction = nums.every(function (n) { return n >= 0 && n <= 1; });
    return nums.map(function (n) {
      var share = asFraction ? n : n / 100;
      if (!(share >= 0 && share <= 1)) {
        throw new Error('Each share must be from 0% to 100%.');
      }
      return share;
    });
  }

  function requireInt(value, min, max, label) {
    var n = Number(value);
    if (!isFinite(n) || Math.round(n) !== n) {
      throw new Error(label + ' must be a whole number.');
    }
    if (n < min || n > max) {
      throw new Error(label + ' must be from ' + min + ' to ' + max + '.');
    }
    return n;
  }

  function requireNumber(value, min, max, label) {
    var n = Number(value);
    if (!isFinite(n) || n < min || n > max) {
      throw new Error(label + ' must be from ' + min + ' to ' + max + '.');
    }
    return n;
  }

  function normalizeOptions(opts) {
    opts = opts || {};
    var share = Number(opts.share);
    if (!(share >= 0 && share <= 1)) {
      throw new Error('Attacker share must be from 0 to 1.');
    }
    var back = requireInt(opts.back, 1, 3, 'Start depth');
    var preChain = requireInt(opts.preChain, 1, 100, 'Honest pre-chain length');
    if (preChain < back) {
      throw new Error('Honest pre-chain length must be at least the start depth (' + back + ').');
    }
    var avgBlockTime = requireNumber(opts.avgBlockTime, 0.1, 600, 'Average block time');
    var giveUp = requireInt(opts.giveUp, 1, 64, 'Give-up depth');
    if (giveUp <= back) {
      throw new Error(
        'Give-up depth must be greater than the start depth (' + back +
        '). The attack already begins that far behind.'
      );
    }
    var maxEvents = opts.maxEvents == null ? 4000 : requireInt(opts.maxEvents, 1, 100000, 'Block limit');
    var rnd = typeof opts.rnd === 'function' ? opts.rnd : Math.random;
    return {
      share: share,
      back: back,
      preChain: preChain,
      avgBlockTime: avgBlockTime,
      giveUp: giveUp,
      stopAt: Math.min(giveUp, STALE_GAP),
      maxEvents: maxEvents,
      rnd: rnd,
      Relay: getRelay(opts)
    };
  }

  function expoWait(rnd, mean) {
    var u = rnd();
    if (!(u > 0)) u = 1e-12;
    if (u >= 1) u = 1 - 1e-12;
    return -Math.log(1 - u) * mean;
  }

  function makeBlock(parent, miner, seq, Relay) {
    var block = {
      index: parent.index + 1,
      previousHash: parent.hash,
      timestamp: seq,
      nonce: 0,
      transactions: [],
      miner: miner,
      difficulty: SIM_LEADING
    };
    var nonce = 0;
    var hash = '';
    if (!Relay || typeof Relay.hashBlock !== 'function') {
      throw new Error('RelayBlockchainState.hashBlock is not loaded');
    }
    for (; nonce < 200000; nonce++) {
      block.nonce = nonce;
      hash = Relay.hashBlock(block);
      if (Relay.prototype.hashMeetsDifficulty(hash, SIM_LEADING, SIM_SECONDARY)) break;
    }
    block.hash = hash;
    block.nonce = nonce;
    return block;
  }

  function tipOf(state) {
    return state.chain[state.chain.length - 1];
  }

  /**
   * One private-chain race.
   * opts.share is a fraction in [0, 1]. opts.rnd() drives both the wait and
   * which side finds the block. A value below `share` is the attacker.
   */
  function runTrial(opts) {
    var o = normalizeOptions(opts);
    var state = new o.Relay('SIM');
    state.updateSettings({
      autoDifficulty: false,
      difficultyLeading: SIM_LEADING,
      difficultySecondary: SIM_SECONDARY
    });
    state.ensureGenesis();

    var seq = 1;
    var i;
    for (i = 0; i < o.preChain; i++) {
      var setup = makeBlock(tipOf(state), 'honest', seq++, o.Relay);
      var setupResult = state.tryAddBlock(setup, 'honest');
      if (!setupResult.accepted) {
        return finish(o, state, null, false, 0, 0, 0, 0, 'Rejected: ' + setupResult.reason);
      }
    }

    var atk = state.chain[state.chain.length - 1 - o.back];
    var seconds = 0;
    var events = 0;
    var attackerBlocks = 0;
    var honestBlocks = 0;

    while (events < o.maxEvents) {
      var gap = tipOf(state).index - atk.index;
      if (gap >= o.stopAt) {
        return finish(o, state, atk, false, attackerBlocks, honestBlocks, seconds, events, 'Fell ' + gap + ' behind');
      }
      events += 1;
      seconds += expoWait(o.rnd, o.avgBlockTime);
      if (o.rnd() < o.share) {
        var block = makeBlock(atk, 'attacker', seq++, o.Relay);
        var added = state.tryAddBlock(block, 'attacker');
        if (!added.accepted) {
          var stuck = tipOf(state).index - atk.index;
          if (/stale parent/i.test(added.reason || '')) {
            return finish(o, state, atk, false, attackerBlocks, honestBlocks, seconds, events, 'Fell ' + stuck + ' behind');
          }
          return finish(o, state, atk, false, attackerBlocks, honestBlocks, seconds, events, 'Rejected: ' + added.reason);
        }
        atk = block;
        attackerBlocks += 1;
        if (state.chain.some(function (b) { return b && b.hash === block.hash; })) {
          return finish(
            o, state, atk, true, attackerBlocks, honestBlocks, seconds, events,
            'Reorg at block ' + block.index
          );
        }
      } else {
        var honest = makeBlock(tipOf(state), 'honest', seq++, o.Relay);
        var honestResult = state.tryAddBlock(honest, 'honest');
        if (!honestResult.accepted) {
          return finish(o, state, atk, false, attackerBlocks, honestBlocks, seconds, events, 'Rejected: ' + honestResult.reason);
        }
        honestBlocks += 1;
      }
    }

    return finish(o, state, atk, false, attackerBlocks, honestBlocks, seconds, events, 'Reached the block limit');
  }

  function finish(o, state, atk, ok, attackerBlocks, honestBlocks, seconds, events, reason) {
    var tip = tipOf(state);
    var gap = atk && tip ? tip.index - atk.index : null;
    return {
      ok: ok,
      share: o.share,
      back: o.back,
      attackerBlocks: attackerBlocks,
      honestBlocks: honestBlocks,
      seconds: seconds,
      events: events,
      reason: reason,
      tipIndex: tip ? tip.index : 0,
      tipMiner: tip ? tip.miner : '',
      gap: gap,
      giveUp: o.giveUp,
      stopAt: o.stopAt
    };
  }

  function summarize(rows) {
    var order = [];
    var by = Object.create(null);
    rows.forEach(function (row) {
      var key = String(row.share);
      if (!by[key]) {
        by[key] = { share: row.share, trials: 0, wins: 0, failures: 0 };
        order.push(key);
      }
      by[key].trials += 1;
      if (row.ok) by[key].wins += 1;
      else by[key].failures += 1;
    });
    return order.map(function (key) {
      var row = by[key];
      row.winRate = row.trials ? row.wins / row.trials : 0;
      return row;
    });
  }

  function runStudy(opts) {
    opts = opts || {};
    var shares = opts.shares;
    if (!Array.isArray(shares) || !shares.length) {
      throw new Error('Enter at least one hash share.');
    }
    var trials = requireInt(opts.trials, 1, 500, 'Trials per share');
    var rnd = typeof opts.rnd === 'function' ? opts.rnd : createRng(opts.seed);
    var rows = [];
    var s;
    var t;
    for (s = 0; s < shares.length; s++) {
      for (t = 0; t < trials; t++) {
        var row = runTrial({
          share: shares[s],
          back: opts.back,
          preChain: opts.preChain,
          avgBlockTime: opts.avgBlockTime,
          giveUp: opts.giveUp,
          maxEvents: opts.maxEvents,
          rnd: rnd,
          Relay: opts.Relay
        });
        row.n = rows.length + 1;
        rows.push(row);
      }
    }
    return { rows: rows, summary: summarize(rows), seedLabel: rnd.label || '', seeded: !!rnd.seeded };
  }

  function runStudyAsync(opts, hooks) {
    hooks = hooks || {};
    var shares = opts.shares;
    var trials = requireInt(opts.trials, 1, 500, 'Trials per share');
    var rnd = typeof opts.rnd === 'function' ? opts.rnd : createRng(opts.seed);
    var rows = [];
    var si = 0;
    var ti = 0;
    var total = shares.length * trials;

    function tick() {
      if (hooks.isCancelled && hooks.isCancelled()) return;
      var started = Date.now();
      try {
        while (si < shares.length && Date.now() - started < 20) {
          var row = runTrial({
            share: shares[si],
            back: opts.back,
            preChain: opts.preChain,
            avgBlockTime: opts.avgBlockTime,
            giveUp: opts.giveUp,
            rnd: rnd,
            Relay: opts.Relay
          });
          row.n = rows.length + 1;
          rows.push(row);
          ti += 1;
          if (ti >= trials) {
            ti = 0;
            si += 1;
          }
        }
      } catch (err) {
        if (hooks.onError) hooks.onError(err);
        return;
      }
      if (si < shares.length) {
        if (hooks.onProgress) hooks.onProgress(rows.length, total);
        setTimeout(tick, 0);
        return;
      }
      if (hooks.onDone) {
        hooks.onDone({
          rows: rows,
          summary: summarize(rows),
          seedLabel: rnd.label || '',
          seeded: !!rnd.seeded
        });
      }
    }

    if (!total) {
      if (hooks.onDone) hooks.onDone({ rows: [], summary: [], seedLabel: rnd.label || '', seeded: !!rnd.seeded });
      return;
    }
    setTimeout(tick, 0);
  }

  function formatShare(share) {
    var pct = Math.round(share * 1000) / 10;
    if (Math.abs(pct - Math.round(pct)) < 1e-9) return String(Math.round(pct)) + '%';
    return String(pct) + '%';
  }

  function formatSeconds(seconds) {
    if (!(seconds >= 0)) return '—';
    if (seconds < 10) return (Math.round(seconds * 10) / 10).toFixed(1) + 's';
    return Math.round(seconds) + 's';
  }

  function formatRate(rate) {
    return (rate * 100).toFixed(1) + '%';
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function readForm(doc) {
    var shares = parseShares(doc.getElementById('atkShares').value);
    var back = requireInt(doc.getElementById('atkBack').value, 1, 3, 'Blocks back');
    var trials = requireInt(doc.getElementById('atkTrials').value, 1, 500, 'Trials per share');
    var preChain = requireInt(doc.getElementById('atkPreChain').value, 1, 100, 'Honest pre-chain length');
    var avgBlockTime = requireNumber(doc.getElementById('atkBlockTime').value, 0.1, 600, 'Average block time');
    var giveUp = requireInt(doc.getElementById('atkGiveUp').value, 1, 64, 'Give-up depth');
    var seedEl = doc.getElementById('atkSeed');
    return {
      shares: shares,
      back: back,
      trials: trials,
      preChain: preChain,
      avgBlockTime: avgBlockTime,
      giveUp: giveUp,
      seed: seedEl ? seedEl.value : ''
    };
  }

  function renderSummary(summary) {
    return summary.map(function (row) {
      return '<tr>' +
        '<td>' + esc(formatShare(row.share)) + '</td>' +
        '<td>' + row.trials + '</td>' +
        '<td>' + row.wins + '</td>' +
        '<td>' + row.failures + '</td>' +
        '<td>' + esc(formatRate(row.winRate)) + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderChart(summary) {
    return summary.map(function (row) {
      var pct = row.trials ? (100 * row.wins / row.trials) : 0;
      var width = Math.max(0, Math.min(100, pct));
      return '<div class="attack-chart__row">' +
        '<span>' + esc(formatShare(row.share)) + '</span>' +
        '<div class="attack-chart__track"><div class="attack-chart__bar" style="width:' + width.toFixed(1) + '%"></div></div>' +
        '<span>' + esc(pct.toFixed(1)) + '%</span>' +
        '</div>';
    }).join('');
  }

  function renderTrials(rows) {
    return rows.map(function (row) {
      var klass = row.ok ? 'attack-result--win' : 'attack-result--fail';
      var word = row.ok ? 'Win' : 'Fail';
      return '<tr>' +
        '<td>' + row.n + '</td>' +
        '<td>' + esc(formatShare(row.share)) + '</td>' +
        '<td>' + row.back + '</td>' +
        '<td class="' + klass + '">' + word + '</td>' +
        '<td>' + row.attackerBlocks + ' / ' + row.honestBlocks + '</td>' +
        '<td>' + esc(formatSeconds(row.seconds)) + '</td>' +
        '<td>' + esc(row.reason) + '</td>' +
        '</tr>';
    }).join('');
  }

  var runGen = 0;

  function bind(doc) {
    doc = doc || document;
    var form = doc.getElementById('attackSimForm');
    if (!form || form.getAttribute('data-bound') === '1') return;
    form.setAttribute('data-bound', '1');
    var button = doc.getElementById('runBtn');
    var status = doc.getElementById('simStatus');
    var error = doc.getElementById('simError');
    var results = doc.getElementById('simResults');

    function showError(message) {
      if (!error) return;
      error.textContent = message;
      error.style.display = message ? 'block' : 'none';
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var options;
      try {
        options = readForm(doc);
      } catch (err) {
        showError(err && err.message ? err.message : String(err));
        return;
      }
      showError('');
      var gen = ++runGen;
      var startedAt = Date.now();
      if (button) {
        button.disabled = true;
        button.textContent = 'Running…';
      }
      if (status) status.textContent = 'Running trial 0…';

      runStudyAsync(options, {
        isCancelled: function () { return gen !== runGen; },
        onProgress: function (done, total) {
          if (gen !== runGen) return;
          if (button) button.textContent = 'Running… ' + done + ' / ' + total;
          if (status) status.textContent = 'Running trial ' + done + ' of ' + total + '…';
        },
        onError: function (err) {
          if (gen !== runGen) return;
          if (button) {
            button.disabled = false;
            button.textContent = 'Run simulation';
          }
          showError(err && err.message ? err.message : String(err));
          if (status) status.textContent = '';
        },
        onDone: function (study) {
          if (gen !== runGen) return;
          if (button) {
            button.disabled = false;
            button.textContent = 'Run simulation';
          }
          var browserSec = ((Date.now() - startedAt) / 1000).toFixed(1);
          var seedNote = study.seeded
            ? 'Seed ' + study.seedLabel + ' will replay these trials.'
            : 'This run used Math.random. Enter a seed to replay a run.';
          var wallNote = '';
          if (options.giveUp > STALE_GAP) {
            wallNote = ' Give-up was set to ' + options.giveUp +
              '. Trials still stop at ' + STALE_GAP + ' behind, because the hub rejects a parent more than ' +
              STALE_PARENT_LIMIT + ' blocks back.';
          }
          if (status) {
            status.textContent = 'Finished ' + study.rows.length + ' trials in ' + browserSec +
              's of browser time. ' + seedNote + wallNote;
          }
          var note = doc.getElementById('resultNote');
          if (note) {
            note.textContent = 'Each share ran ' + options.trials + ' trial' +
              (options.trials === 1 ? '' : 's') + ', starting ' + options.back +
              ' block' + (options.back === 1 ? '' : 's') +
              ' back, on an honest chain of ' + options.preChain +
              ' blocks. Average block time ' + options.avgBlockTime + 's. ' + seedNote;
          }
          var summaryBody = doc.getElementById('summaryBody');
          var chart = doc.getElementById('winChart');
          var trialBody = doc.getElementById('trialBody');
          if (summaryBody) summaryBody.innerHTML = renderSummary(study.summary);
          if (chart) {
            chart.innerHTML = renderChart(study.summary);
            var bits = study.summary.map(function (row) {
              return formatShare(row.share) + ' ' + formatRate(row.winRate);
            });
            chart.setAttribute('aria-label', 'Win rate by attacker hash share: ' + bits.join(', '));
          }
          if (trialBody) trialBody.innerHTML = renderTrials(study.rows);
          if (results) {
            results.style.display = 'block';
            if (results.scrollIntoView) results.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      });
    });
  }

  global.AttackSim = {
    STALE_PARENT_LIMIT: STALE_PARENT_LIMIT,
    STALE_GAP: STALE_GAP,
    parseShares: parseShares,
    createRng: createRng,
    formatShare: formatShare,
    formatSeconds: formatSeconds,
    runTrial: runTrial,
    runStudy: runStudy,
    runStudyAsync: runStudyAsync,
    summarize: summarize,
    bind: bind
  };

  if (typeof document !== 'undefined' && document.getElementById && document.getElementById('attackSimForm')) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { bind(document); });
    } else {
      bind(document);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
