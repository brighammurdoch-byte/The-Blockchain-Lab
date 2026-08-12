(function () {
  var chain = new BitcoinLab.Chain();
  var editor = null;
  var myAddr = 'student';

  function $(id) { return document.getElementById(id); }

  function fmtBtc(sats) {
    return (Number(sats) / BitcoinLab.COIN).toFixed(4) + ' BTC';
  }

  function render() {
    var snap = chain.snapshot();
    $('btcHeight').textContent = String(snap.height);
    $('btcTip').textContent = snap.tip.slice(0, 20) + '…';
    $('btcSubsidy').textContent = snap.subsidyBtc + ' BTC';
    $('btcUtxos').textContent = String(snap.utxos);
    $('btcMempool').textContent = String(snap.mempool);
    $('btcBalance').textContent = fmtBtc(chain.balanceOf(myAddr));
    $('btcNextHalving').textContent = String(snap.nextHalving);
    var rows = snap.blocks.slice().reverse().map(function (b) {
      return '<tr><td>' + b.height + '</td><td><code>' + (b.hash || '').slice(0, 16) + '…</code></td><td>' +
        b.miner + '</td><td>' + (b.subsidy / BitcoinLab.COIN) + '</td><td>' + (b.txs || []).length + '</td></tr>';
    }).join('');
    $('btcBlocks').innerHTML = rows || '<tr><td colspan="5">No blocks</td></tr>';
  }

  function setNotes(notes, kind) {
    var el = $('btcTranslateNotes');
    if (!el) return;
    el.className = 'alert ' + (kind === 'error' ? 'alert-danger' : 'alert-success');
    el.innerHTML = (notes && notes.length) ? notes.map(function (n) { return '• ' + n; }).join('<br>') : 'Rules applied.';
    el.style.display = 'block';
  }

  function applyEditor() {
    var src = editor ? editor.getValue() : '';
    var mapped = BitcoinTranslate.translate(src);
    if (!mapped.ok) {
      setNotes([mapped.error || 'translate failed'], 'error');
      return;
    }
    chain.params = Object.assign(chain.params, mapped.params);
    setNotes(mapped.notes.concat(['Existing UTXOs kept. New blocks use the new subsidy / checks.']));
    render();
  }

  function bootEditor() {
    if (window.ace && ace.config) {
      ace.config.set('basePath', 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.15.0/');
      ace.config.set('workerPath', 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.15.0/');
    }
    editor = ace.edit('btcEditor');
    editor.setTheme('ace/theme/monokai');
    editor.session.setMode('ace/mode/c_cpp');
    editor.session.setUseWorker(false);
    editor.setFontSize(13);
    editor.setValue(BitcoinTranslate.TEMPLATE, -1);
  }

  document.addEventListener('DOMContentLoaded', function () {
    bootEditor();
    render();

    $('btcMineBtn').addEventListener('click', function () {
      var r = chain.mine(myAddr);
      if (!r.ok) {
        setNotes([r.error], 'error');
      } else {
        setNotes(['Mined block #' + r.block.height + ' subsidy ' + (r.block.subsidy / BitcoinLab.COIN) + ' BTC']);
      }
      render();
    });

    $('btcSendBtn').addEventListener('click', function () {
      var to = $('btcSendTo').value.trim() || 'peer';
      var amt = parseFloat($('btcSendAmt').value);
      var r = chain.addTransaction(myAddr, to, amt);
      if (!r.ok) setNotes([r.error], 'error');
      else setNotes(['Queued ' + amt + ' BTC to ' + to + ' — mine a block to confirm']);
      render();
    });

    $('btcApplyBtn').addEventListener('click', applyEditor);
    $('btcResetBtn').addEventListener('click', function () {
      editor.setValue(BitcoinTranslate.TEMPLATE, -1);
      chain = new BitcoinLab.Chain();
      setNotes(['Reset to Core-shaped defaults and a fresh chain.']);
      render();
    });
  });
})();
