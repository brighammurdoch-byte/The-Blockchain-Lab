/**
 * Read Core-shaped C++ and map named consensus knobs onto BitcoinLab params.
 * This is not a C++ compiler.
 */
(function (global) {
  var TEMPLATE = [
    '// consensus/amount.h + validation.cpp + pow.cpp  (trimmed Bitcoin Core shape)',
    '// Teaching twin — the lab reads the constants and checks below; it does not run clang.',
    '',
    'static const CAmount COIN = 100000000;',
    'static const CAmount MAX_MONEY = 21000000 * COIN;',
    'static const int COINBASE_MATURITY = 100; // Core is 100; lab default is scaled in params',
    '',
    'struct Params {',
    '    int nSubsidyHalvingInterval = 210000;',
    '    int64_t nPowTargetSpacing = 10 * 60;          // 10 minutes in Core',
    '    int64_t nPowTargetTimespan = 14 * 24 * 60 * 60; // 2 weeks in Core',
    '    int DifficultyAdjustmentInterval() const {',
    '        return nPowTargetTimespan / nPowTargetSpacing; // 2016 in Core',
    '    }',
    '};',
    '',
    'CAmount GetBlockSubsidy(int nHeight, const Params& consensusParams)',
    '{',
    '    int halvings = nHeight / consensusParams.nSubsidyHalvingInterval;',
    '    if (halvings >= 64)',
    '        return 0;',
    '    CAmount nSubsidy = 50 * COIN;',
    '    nSubsidy >>= halvings;',
    '    return nSubsidy;',
    '}',
    '',
    'bool CheckTransaction(const CTransaction& tx, TxValidationState& state)',
    '{',
    '    if (tx.vin.empty())',
    '        return false; // empty vin (except coinbase, handled by caller)',
    '    if (tx.vout.empty())',
    '        return false;',
    '    CAmount nValueOut = 0;',
    '    for (const auto& out : tx.vout) {',
    '        nValueOut += out.nValue;',
    '        if (nValueOut > MAX_MONEY)',
    '            return false;',
    '    }',
    '    return true;',
    '}',
    '',
    'bool CheckBlock(const CBlock& block, const CBlockIndex* pindexPrev)',
    '{',
    '    if (pindexPrev && block.hashPrevBlock != pindexPrev->GetBlockHash())',
    '        return false;',
    '    // Proof-of-work: SHA256d(header) must be below the compact target (nBits).',
    '    return CheckProofOfWork(block.GetHash(), block.nBits);',
    '}',
    ''
  ].join('\n');

  function num(src, re, fallback) {
    var m = src.match(re);
    if (!m) return fallback;
    var n = parseInt(m[1], 10);
    return isNaN(n) ? fallback : n;
  }

  function translate(src) {
    var base = global.BitcoinLab ? global.BitcoinLab.defaultParams() : {};
    var out = Object.assign({}, base);
    if (!src) return { ok: true, params: out, notes: ['empty source — using defaults'] };
    var notes = [];

    var subsidy = num(src, /CAmount\s+nSubsidy\s*=\s*(\d+)\s*\*\s*COIN/, null);
    if (subsidy != null) {
      out.subsidyCoins = subsidy;
      notes.push('GetBlockSubsidy era-0 reward = ' + subsidy + ' BTC');
    }

    var halv = num(src, /nSubsidyHalvingInterval\s*=\s*(\d+)/, null);
    if (halv != null) {
      out.halvingInterval = Math.max(1, halv);
      notes.push('halving interval = ' + out.halvingInterval + ' blocks');
    }

    var spacing = num(src, /nPowTargetSpacing\s*=\s*([0-9]+)/, null);
    var span = num(src, /nPowTargetTimespan\s*=\s*([0-9]+)/, null);
    if (src.indexOf('14 * 24 * 60 * 60') !== -1) span = 14 * 24 * 60 * 60;
    if (src.indexOf('10 * 60') !== -1 && spacing == null) spacing = 600;
    var adj = num(src, /DifficultyAdjustmentInterval[\s\S]*?return\s+(\d+)/, null);
    if (adj != null) {
      out.difficultyInterval = Math.max(2, adj);
      notes.push('lab retarget interval mapped from DifficultyAdjustmentInterval() = ' + adj);
    } else if (span && spacing) {
      out.difficultyInterval = Math.max(2, Math.round(span / spacing));
      notes.push('lab retarget interval = timespan/spacing = ' + out.difficultyInterval);
    }

    var mat = num(src, /COINBASE_MATURITY\s*=\s*(\d+)/, null);
    if (mat != null) {
      // Core is 100; keep student value but floor at 1
      out.coinbaseMaturity = Math.max(1, Math.min(mat, 1000));
      notes.push('coinbase maturity = ' + out.coinbaseMaturity + ' blocks');
    }

    var maxMoney = num(src, /MAX_MONEY\s*=\s*(\d+)\s*\*\s*COIN/, null);
    if (maxMoney != null) {
      out.maxMoneyCoins = maxMoney;
      notes.push('MAX_MONEY = ' + maxMoney + ' BTC');
    }

    out.checkMaxMoney = /nValueOut\s*>\s*MAX_MONEY/.test(src);
    out.checkEmptyVin = /vin\.empty\(\)/.test(src);
    if (!out.checkMaxMoney) notes.push('MAX_MONEY check removed — oversized outputs accepted');
    if (!out.checkEmptyVin) notes.push('empty-vin check removed');

    return { ok: true, params: out, notes: notes };
  }

  global.BitcoinTranslate = {
    TEMPLATE: TEMPLATE,
    translate: translate
  };
})(typeof window !== 'undefined' ? window : globalThis);
