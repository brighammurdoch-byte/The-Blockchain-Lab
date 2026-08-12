(function () {
  var chain = new EthereumLab.Chain();
  var editor = null;
  var me = '0xStudent';

  function $(id) { return document.getElementById(id); }

  function fmtEth(wei) {
    return (Number(wei) / EthereumLab.WEI).toFixed(4) + ' ETH';
  }

  function render() {
    var snap = chain.snapshot();
    $('ethNumber').textContent = String(snap.number);
    $('ethTip').textContent = snap.tip.slice(0, 20) + '…';
    $('ethReward').textContent = snap.rewardEth + ' ETH';
    $('ethGas').textContent = String(snap.gasLimit);
    $('ethMempool').textContent = String(snap.mempool);
    $('ethBalance').textContent = fmtEth(chain.balanceOf(me));
    var rows = snap.blocks.slice().reverse().map(function (b) {
      return '<tr><td>' + b.number + '</td><td><code>' + (b.hash || '').slice(0, 16) + '…</code></td><td>' +
        b.miner + '</td><td>' + ((b.reward || 0) / EthereumLab.WEI) + '</td><td>' + (b.txs || []).length + '</td></tr>';
    }).join('');
    $('ethBlocks').innerHTML = rows || '<tr><td colspan="5">No blocks</td></tr>';
    var accts = snap.accounts.map(function (a) {
      return '<tr><td><code>' + a.addr + '</code></td><td>' + a.eth.toFixed(4) + '</td><td>' + a.nonce + '</td></tr>';
    }).join('');
    $('ethAccounts').innerHTML = accts || '<tr><td colspan="3">No accounts</td></tr>';
  }

  function setNotes(notes, kind) {
    var el = $('ethTranslateNotes');
    if (!el) return;
    el.className = 'alert ' + (kind === 'error' ? 'alert-danger' : 'alert-success');
    el.innerHTML = (notes && notes.length) ? notes.map(function (n) { return '• ' + n; }).join('<br>') : 'Rules applied.';
    el.style.display = 'block';
  }

  function applyEditor(rebuild) {
    var src = editor ? editor.getValue() : '';
    var mapped = EthereumTranslate.translate(src);
    if (!mapped.ok) {
      setNotes([mapped.error || 'translate failed'], 'error');
      return;
    }
    if (rebuild) {
      chain = new EthereumLab.Chain(mapped.params);
      setNotes(mapped.notes.concat(['Genesis rebuilt so INITIAL_SUPPLY takes effect.']));
    } else {
      chain.params = Object.assign(chain.params, mapped.params);
      setNotes(mapped.notes.concat(['Live params updated. INITIAL_SUPPLY only applies if you Reset.']));
    }
    render();
  }

  function bootEditor() {
    if (window.ace && ace.config) {
      ace.config.set('basePath', 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.15.0/');
      ace.config.set('workerPath', 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.15.0/');
    }
    editor = ace.edit('ethEditor');
    editor.setTheme('ace/theme/monokai');
    editor.session.setMode('ace/mode/javascript');
    editor.session.setUseWorker(false);
    editor.setFontSize(13);
    editor.setValue(EthereumTranslate.TEMPLATE, -1);
  }

  document.addEventListener('DOMContentLoaded', function () {
    bootEditor();
    chain._acct(me).balance = 5 * EthereumLab.WEI;
    render();

    $('ethMineBtn').addEventListener('click', function () {
      var r = chain.mine(me);
      if (!r.ok) setNotes([r.error], 'error');
      else setNotes(['Proposed block #' + r.block.number + ' — issuance ' + (r.block.reward / EthereumLab.WEI) + ' ETH']);
      render();
    });

    $('ethSendBtn').addEventListener('click', function () {
      var to = $('ethSendTo').value.trim() || '0xPeer';
      var amt = parseFloat($('ethSendAmt').value);
      var r = chain.addTransaction(me, to, amt);
      if (!r.ok) setNotes([r.error], 'error');
      else setNotes(['Queued ' + amt + ' ETH to ' + to + ' — mine to include it']);
      render();
    });

    $('ethFaucetBtn').addEventListener('click', function () {
      chain._acct(me).balance += 5 * EthereumLab.WEI;
      setNotes(['Treasury sent 5 ETH-units to 0xStudent (demo faucet).']);
      render();
    });

    $('ethApplyBtn').addEventListener('click', function () { applyEditor(false); });
    $('ethResetBtn').addEventListener('click', function () {
      editor.setValue(EthereumTranslate.TEMPLATE, -1);
      applyEditor(true);
      chain._acct(me).balance += 5 * EthereumLab.WEI;
      render();
    });
  });
})();
