/**
 * Read Solidity-shaped source and map knobs onto EthereumLab params.
 * This is not solc and not the EVM.
 */
(function (global) {
  var TEMPLATE = [
    '// SPDX-License-Identifier: MIT',
    '// Teaching twin of an issuance + ERC-20-like transfer. Not compiled by solc.',
    'pragma solidity ^0.8.0;',
    '',
    'contract LabCoin {',
    '    uint256 public constant INITIAL_SUPPLY = 21 * 10**18; // 21 ETH-denominated units at genesis',
    '    uint256 public constant BLOCK_REWARD = 2 * 10**18;    // teaching stand-in for issuance',
    '    uint256 public constant TRANSFER_GAS = 21000;',
    '    uint256 public constant BLOCK_GAS_LIMIT = 30000000;',
    '',
    '    mapping(address => uint256) public balanceOf;',
    '    mapping(address => uint256) public nonces;',
    '',
    '    function transfer(address to, uint256 amount) public returns (bool) {',
    '        require(balanceOf[msg.sender] >= amount, "insufficient balance");',
    '        require(to != address(0), "zero address");',
    '        balanceOf[msg.sender] -= amount;',
    '        balanceOf[to] += amount;',
    '        return true;',
    '    }',
    '}',
    ''
  ].join('\n');

  function num(src, re, fallback) {
    var m = src.match(re);
    if (!m) return fallback;
    var n = parseFloat(m[1]);
    return isNaN(n) ? fallback : n;
  }

  function translate(src) {
    var base = global.EthereumLab ? global.EthereumLab.defaultParams() : {};
    var out = Object.assign({}, base);
    if (!src) return { ok: true, params: out, notes: ['empty source — using defaults'] };
    var notes = [];

    var supply = num(src, /INITIAL_SUPPLY\s*=\s*([0-9.]+)\s*\*\s*10\s*\*\*\s*18/, null);
    if (supply != null) {
      out.initialSupplyEth = supply;
      notes.push('genesis treasury = ' + supply + ' ETH-units');
    }
    var reward = num(src, /BLOCK_REWARD\s*=\s*([0-9.]+)\s*\*\s*10\s*\*\*\s*18/, null);
    if (reward != null) {
      out.blockRewardEth = reward;
      notes.push('block issuance = ' + reward + ' ETH-units');
    }
    var gas = num(src, /TRANSFER_GAS\s*=\s*([0-9]+)/, null);
    if (gas != null) {
      out.transferGas = gas;
      notes.push('transfer gas = ' + gas);
    }
    var limit = num(src, /BLOCK_GAS_LIMIT\s*=\s*([0-9]+)/, null);
    if (limit != null) {
      out.blockGasLimit = limit;
      notes.push('block gas limit = ' + limit);
    }

    out.enforceBalance = /require\s*\(\s*balanceOf\s*\[\s*msg\.sender\s*\]\s*>=\s*amount/.test(src);
    if (!out.enforceBalance) notes.push('balance require() removed — overdrafts allowed');

    return { ok: true, params: out, notes: notes };
  }

  global.EthereumTranslate = {
    TEMPLATE: TEMPLATE,
    translate: translate
  };
})(typeof window !== 'undefined' ? window : globalThis);
