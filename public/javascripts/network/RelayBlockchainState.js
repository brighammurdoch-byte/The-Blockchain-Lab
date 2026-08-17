/**
 * RelayBlockchainState
 *
 * Lightweight in-memory blockchain for the Admin when running in client-relay mode.
 * The admin's browser becomes the source of truth / canonical chain for the room.
 *
 * Goals:
 * - Simple but functional for classroom demos
 * - Support block submission from miners via the relay
 * - Send consistent initial state to newly joined peers
 * - Broadcast updates when the chain grows
 * - Survive admin page refresh (via Persistence)
 */

if (typeof window.RelayBlockchainState === 'undefined') {
  class RelayBlockchainState {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.chain = [];
    this.participants = new Map(); // userId -> { userId, role, name, hashrate, blocksMined, balance, joinedAt }
    this.pendingTransactions = [];
    this.settings = {
      // Start at 3 + 0x8; auto-difficulty still climbs toward targetBlockTimeSec
      difficultyLeading: 3,
      difficultySecondary: 8,
      miningRewardCoins: 10,
      chainFlavor: 'classic',
      halvingInterval: 21,
      parametersLocked: false,
      networkMode: 'admin-relay',
      /** Desired average seconds between blocks (classroom pacing). */
      targetBlockTimeSec: 10,
      /** When true, hub nudges difficulty after each tip extension. */
      autoDifficulty: true
    };
    this.networkStats = {
      totalHashrate: 0,
      blockHeight: 0,
      lastBlockTime: null,
      totalTransactions: 0,
      averageBlockTimeMs: null,
      blockIntervals: []
    };
    this.allBlocks = new Map(); // hash -> block (for simple fork/orphan handling)
    this.knownNames = new Map(); // userId -> last applied classroom name (survives prune)
    this.genesisCreated = false;
    this.networkPaused = false;
    /** { height, name } when a classroom hard fork is proposed */
    this.pendingFork = null;
  }

  // Create a minimal genesis block
  ensureGenesis() {
    if (this.genesisCreated && this.chain.length > 0) return;

    const genesis = {
      index: 0,
      hash: '0000000000000000000000000000000000000000000000000000000000000000',
      previousHash: '0',
      timestamp: Date.now() - 10000,
      nonce: 0,
      transactions: [],
      miner: 'genesis',
      difficulty: this.settings.difficultyLeading,
      data: 'Genesis Block - Blockchain Lab (Client Relay)'
    };

    this.chain = [genesis];
    this.allBlocks.set(genesis.hash, genesis);
    this.genesisCreated = true;
    this.networkStats.blockHeight = 0;
    // Wall-clock, not genesis.timestamp (that is Date.now()-10s and
    // immediately looks like a stall once miners start hashing).
    this.networkStats.lastBlockTime = Date.now();
    this.networkStats._lastTipWallClock = Date.now();
  }

  // Update admin settings (called when admin changes sliders)
  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    if (this.settings.targetBlockTimeSec != null) {
      const t = Number(this.settings.targetBlockTimeSec);
      this.settings.targetBlockTimeSec = isNaN(t) ? 10 : Math.max(2, Math.min(120, t));
    }
    if (this.settings.autoDifficulty != null) {
      this.settings.autoDifficulty = !!this.settings.autoDifficulty;
    }
    // Always expose a miner-friendly difficulty object
    const leading = this.settings.difficultyLeading != null ? this.settings.difficultyLeading : 3;
    const secondary = this.settings.difficultySecondary !== undefined ? this.settings.difficultySecondary : 8;
    this.settings.difficultyLeading = leading;
    this.settings.difficultySecondary = secondary;
    this.settings.currentDifficulty = {
      leadingZeros: leading,
      secondaryHex: Number(secondary).toString(16).toUpperCase()
    };
  }

  calculateDifficulty(leading, secondary) {
    return {
      leadingZeros: leading || 3,
      secondaryHex: Number(secondary !== undefined ? secondary : 15).toString(16).toUpperCase()
    };
  }

  /** Encode leading zeros + secondary nibble as a single ladder step. */
  _difficultyScore(leading, secondary) {
    const L = Math.max(1, Math.min(6, Number(leading) || 1));
    const S = Math.max(0, Math.min(15, Number(secondary) || 0));
    return L * 16 + S;
  }

  _autoMaxScore() {
    // ~80 kH/s classroom needs ~5 leading zeros to land near 10s.
    // Remine-on-reject + stall-ease keep 4–5 from freezing the class.
    return 5 * 16 + 12;
  }

  /** Expected hashes for leading zeros L and next-nibble ≤ S. */
  _expectedHashes(leading, secondary) {
    const L = Math.max(1, Math.min(6, Number(leading) || 1));
    const S = Math.max(0, Math.min(15, Number(secondary) || 0));
    return Math.pow(16, L + 1) / (S + 1);
  }

  /** Ladder score whose expected hashes is closest to wantHashes. */
  _scoreForTargetHashes(wantHashes) {
    const want = Math.max(16, Number(wantHashes) || 16);
    let best = 1 * 16 + 0;
    let bestErr = Infinity;
    const minScore = 1 * 16 + 0;
    const maxScore = this._autoMaxScore();
    for (let s = minScore; s <= maxScore; s++) {
      const exp = this._expectedHashes(Math.floor(s / 16), s % 16);
      const err = Math.abs(Math.log(exp) - Math.log(want));
      if (err < bestErr) {
        bestErr = err;
        best = s;
      }
    }
    return best;
  }

  _scoreToDifficulty(score) {
    const minScore = 1 * 16 + 0;
    const maxScore = this._autoMaxScore();
    const s = Math.max(minScore, Math.min(maxScore, score));
    return {
      difficultyLeading: Math.floor(s / 16),
      difficultySecondary: s % 16
    };
  }

  hashMeetsDifficulty(hash, leading, secondary) {
    const h = String(hash || '');
    const L = Math.max(0, Number(leading) || 0);
    if (L > 0 && !h.startsWith('0'.repeat(L))) return false;
    if (L > 0) {
      const nextChar = h.charAt(L);
      const secHex = Number(secondary != null ? secondary : 15).toString(16).toLowerCase();
      if (nextChar && nextChar.toLowerCase() > secHex) return false;
    }
    return true;
  }

  /** Median of positive samples. More stable than the mean for classroom bursts/stalls. */
  _medianMs(values) {
    const xs = (values || []).filter(function (v) { return v > 0 && isFinite(v); }).slice().sort(function (a, b) { return a - b; });
    if (!xs.length) return 0;
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  }

  _targetMs() {
    const targetSec = Number(this.settings && this.settings.targetBlockTimeSec);
    return Math.max(2000, Math.min(120000, (isNaN(targetSec) ? 10 : targetSec) * 1000));
  }

  /**
   * One leading-zero increase per ~3.5× target (35s at 10s). The 5s general
   * cooldown let 1→2→3→4→5 fire in ~20s once lastRetarget.at actually
   * expired (QT0G4E after p4fix3).
   */
  _zeroCooldownMs() {
    return Math.max(this._targetMs() * 3.5, 35000);
  }

  /** Hashrate-implied leading zeros for the 10s classroom target, or null. */
  _wantLeadingFromHashrate() {
    const hs = Number(this.networkStats && this.networkStats.totalHashrate) || 0;
    if (hs <= 500) return null;
    const wantScore = this._scoreForTargetHashes(hs * (this._targetMs() / 1000));
    return Math.floor(wantScore / 16);
  }

  _leadingZeroOnCooldown() {
    const lastRt = this.networkStats && this.networkStats.lastRetarget;
    const at = lastRt && lastRt.leadingZeroAt;
    if (!at) return false;
    return (Date.now() - at) < this._zeroCooldownMs();
  }

  /**
   * Stall-ease zero-drop cooldown. ≥20s was not enough to stop 3→1 in ~22s
   * (ST0R8T): first drop as soon as the 25s freeze armed, second the moment
   * the 20s timer expired. 25s means two drops cannot fit in a 22s watch.
   * Stored on networkStats._stallZeroAt so _commitRetarget cannot wipe it.
   */
  _stallZeroCooldownMs() {
    return Math.max(this._targetMs() * 2.5, 25000);
  }

  /**
   * Wall-clock ms since the last canonical tip. Height change resets the
   * stamps; this must keep incrementing while the tip is frozen (ST0R8T
   * Since Last stuck at 31s because the UI only painted on a new block).
   */
  sinceLastBlockMs(now) {
    now = now != null ? Number(now) : Date.now();
    if (!isFinite(now)) now = Date.now();
    const lastBlk = Number(this.networkStats && this.networkStats.lastBlockTime) || 0;
    const tipWall = Number(this.networkStats && this.networkStats._lastTipWallClock) || 0;
    const last = Math.max(lastBlk, tipWall);
    return last ? Math.max(0, now - last) : 0;
  }

  sinceLastBlockSec(now) {
    return Math.floor(this.sinceLastBlockMs(now) / 1000);
  }

  /**
   * Bound one observed interval so a 0.1s burst or a 101s stall recovery
   * cannot snap the controller. Floor keeps "too fast" visible; cap is 2.5× target.
   */
  _capIntervalMs(intervalMs) {
    const targetMs = this._targetMs();
    const raw = Number(intervalMs);
    if (!(raw > 0) || !isFinite(raw)) return 0;
    return Math.max(250, Math.min(targetMs * 2.5, raw));
  }

  /**
   * Displayed / controller pace. If the tip has been frozen longer than the
   * claimed average, report the wait — never keep advertising 0.1s.
   * Never advertise lastRetarget.avgMs (a stale stall sample) while the
   * stats card shows Since Last Block 0s (XU1J1S leftover 19s).
   */
  observedPaceMs() {
    const targetMs = this._targetMs();
    const intervals = Array.isArray(this.networkStats && this.networkStats.blockIntervals)
      ? this.networkStats.blockIntervals
      : [];
    const median = this._medianMs(intervals.slice(-6));
    const stored = Number(this.networkStats && this.networkStats.averageBlockTimeMs);
    const lastBlk = Number(this.networkStats && this.networkStats.lastBlockTime) || 0;
    const tipWall = Number(this.networkStats && this.networkStats._lastTipWallClock) || 0;
    const watchAt = Number(this.networkStats && this.networkStats._stallWatchAt) || 0;
    const newest = Math.max(lastBlk, tipWall, watchAt);
    const since = newest ? Math.max(0, Date.now() - newest) : 0;
    const claimed = (median > 0) ? median : (stored > 0 ? stored : 0);
    // A tip that just moved (or a stall-watch reset) is not a freeze.
    if (since < targetMs) return claimed;
    if (since > 0 && since > Math.max(targetMs, claimed * 1.5, 4000)) {
      return since;
    }
    return claimed;
  }

  _canonicalTipIndex() {
    const tip = this.chain && this.chain.length ? this.chain[this.chain.length - 1] : null;
    if (tip && tip.index != null && !isNaN(Number(tip.index))) return Number(tip.index);
    if (this.networkStats && this.networkStats.blockHeight != null) {
      return Math.max(0, Number(this.networkStats.blockHeight) || 0);
    }
    return this.chain && this.chain.length ? Math.max(0, this.chain.length - 1) : 0;
  }

  /**
   * Stall-ease must follow canonical height, not a persist/reload wall-clock
   * that stopped updating while students kept extending the tip (XU1J1S).
   */
  _syncStallWatch(tipIndex) {
    if (!this.networkStats) this.networkStats = {};
    const idx = tipIndex != null ? Number(tipIndex) : this._canonicalTipIndex();
    if (this.networkStats._stallWatchHeight == null) {
      this.networkStats._stallWatchHeight = idx;
      this.networkStats._stallWatchAt = this.networkStats._lastTipWallClock
        || this.networkStats.lastBlockTime
        || Date.now();
      return;
    }
    if (this.networkStats._stallWatchHeight !== idx) {
      this.networkStats._stallWatchHeight = idx;
      const now = Date.now();
      this.networkStats._stallWatchAt = now;
      this.networkStats._lastTipWallClock = now;
      this.networkStats.lastBlockTime = now;
    }
  }

  _resetStallClocks() {
    if (!this.networkStats) this.networkStats = {};
    const now = Date.now();
    this.networkStats.lastBlockTime = now;
    this.networkStats._lastTipWallClock = now;
    this.networkStats._stallWatchHeight = this._canonicalTipIndex();
    this.networkStats._stallWatchAt = now;
    // Persist/reload must not inherit a leftover stall-zero timestamp
    // that would either burst-drop or block a real later ease.
    this.networkStats._stallZeroAt = 0;
  }

  /**
   * Nudge difficulty so recent block intervals approach targetBlockTimeSec.
   *
   * Classroom constraint: a 3× hashrate change is ~0.4 leading zeros, not +3
   * zeros. Normal steps are nibble-sized and cooldown-gated. When the median
   * is ≥3× too fast, one leading-zero step is allowed (1→2), never 1→4.
   * Hashrate is a gentle pull, not a snap-to-target.
   * Returns updated settings object if changed, else null.
   */
  maybeRetargetDifficulty() {
    if (!this.settings || !this.settings.autoDifficulty) return null;
    if (this.settings.parametersLocked) return null;

    const targetMs = this._targetMs();
    const lastRt = this.networkStats && this.networkStats.lastRetarget;
    const lastAt = lastRt && lastRt.at;
    // One retarget per ~half target. Without this, 0.3s blocks + hashrate
    // snap climbed 1 leading zero → 4 zeros in a dozen tip extensions.
    const cooldownMs = Math.max(targetMs * 0.5, 5000);
    if (lastAt && Date.now() - lastAt < cooldownMs) return null;

    const intervals = Array.isArray(this.networkStats.blockIntervals)
      ? this.networkStats.blockIntervals
      : [];
    // After a retarget we clear samples; wait for two fresh intervals so the
    // next step measures the new difficulty, not the pre-retarget burst.
    if (intervals.length < 2) return null;

    const recent = intervals.slice(-6);
    const avg = this._medianMs(recent);
    if (!(avg > 0)) return null;

    const ratio = avg / targetMs;
    let delta = 0;
    if (ratio < 0.25) delta = 2;
    else if (ratio < 0.5) delta = 2;
    else if (ratio < 0.8) delta = 1;
    else if (ratio > 2.2) delta = -2;
    else if (ratio > 1.6) delta = -2;
    else if (ratio > 1.25) delta = -1;

    const hs = Number(this.networkStats.totalHashrate) || 0;
    const curScore = this._difficultyScore(
      this.settings.difficultyLeading,
      this.settings.difficultySecondary
    );
    const curLeading = Math.floor(curScore / 16);
    if (hs > 500) {
      const wantHashes = hs * (targetMs / 1000);
      const wantScore = this._scoreForTargetHashes(wantHashes);
      const gap = wantScore - curScore;
      // Hashrate may point at 4 zeros while we are still at 1. Walk toward
      // it one/two nibbles at a time — never jump the whole gap.
      let toward = 0;
      if (gap > 0) toward = Math.min(2, gap);
      else if (gap < 0) toward = Math.max(-2, gap);
      if (toward > 0 && ratio < 0.9) delta = Math.max(delta, toward);
      else if (toward < 0 && ratio > 1.1) delta = Math.min(delta, toward);
      else if (Math.abs(ratio - 1) < 0.25 && Math.abs(toward) <= 2) delta = toward;
    }

    // Score = L*16+S; higher S is more permissive (easier). The ratio table
    // above adds to the score when too fast, which eases the nibble
    // (MYDFSN: 4+0x9 → 0xB at 1.8–3.9s). Too-fast must tighten toward 0x0
    // without walking L backward when S is already 0.
    if (ratio < 1 && delta > 0) {
      const curS = curScore % 16;
      delta = curS > 0 ? -Math.min(delta, curS) : 0;
    }

    // Way-too-fast: ≥3× quicker than target for several fresh samples.
    // Repeatable after the inter-zero cooldown: 1→2, later 2→3. Never 1→4
    // / 2→5 in one retarget. Do not add a zero past the hashrate-implied
    // leading count (4+0xC → 5+0xC was QT0G4E: 1.5s still looked "too fast").
    const wayTooFast = ratio > 0 && ratio < (1 / 3) && recent.length >= 2;
    const wantLeading = this._wantLeadingFromHashrate();
    const lastAddedZero = !!(lastRt && lastRt.addedLeadingZero);
    const samplesForZero = lastAddedZero ? 4 : 2;
    const canAddZero = wayTooFast
      && curLeading < 5
      && !this._leadingZeroOnCooldown()
      && recent.length >= samplesForZero
      && (wantLeading == null || wantLeading > curLeading);
    if (canAddZero) {
      const nextLeading = curLeading + 1;
      const keepS = Math.max(0, Math.min(15, Number(this.settings.difficultySecondary) || 0));
      const next = this._scoreToDifficulty(nextLeading * 16 + keepS);
      if (
        next.difficultyLeading !== this.settings.difficultyLeading ||
        next.difficultySecondary !== this.settings.difficultySecondary
      ) {
        return this._commitRetarget(next, avg, targetMs, ratio, curScore);
      }
    }
    if (wayTooFast && !canAddZero) {
      // Still too fast but another zero is rate-limited or already at the
      // hashrate-implied L. Tighten the nibble (lower S = harder) instead.
      const curS = Math.max(0, Math.min(15, Number(this.settings.difficultySecondary) || 0));
      if (curS > 0) {
        const next = this._scoreToDifficulty(curLeading * 16 + Math.max(0, curS - 2));
        if (
          next.difficultyLeading !== this.settings.difficultyLeading ||
          next.difficultySecondary !== this.settings.difficultySecondary
        ) {
          return this._commitRetarget(next, avg, targetMs, ratio, curScore);
        }
      }
    }

    delta = Math.max(-2, Math.min(2, delta));
    if (delta === 0) return null;

    let nextScore = curScore + delta;
    const nextLeading = Math.floor(nextScore / 16);
    if (nextLeading > curLeading + 1) nextScore = (curLeading + 1) * 16 + 0;
    if (nextLeading < curLeading - 1) nextScore = curLeading * 16 + 0;
    // Too-fast nibble steps must not wrap 2+0x0 → 1+0xE.
    if (ratio < 1 && Math.floor(nextScore / 16) < curLeading) {
      nextScore = curLeading * 16 + 0;
    }
    // Inter-zero cooldown also applies to a nibble step that would cross L.
    if (Math.floor(nextScore / 16) > curLeading && this._leadingZeroOnCooldown()) {
      nextScore = curLeading * 16 + Math.min(15, (curScore % 16));
    }

    const next = this._scoreToDifficulty(nextScore);
    if (
      next.difficultyLeading === this.settings.difficultyLeading &&
      next.difficultySecondary === this.settings.difficultySecondary
    ) {
      return null;
    }

    return this._commitRetarget(next, avg, targetMs, ratio, curScore);
  }

  _commitRetarget(next, avg, targetMs, ratio, curScore) {
    const nextScore = this._difficultyScore(next.difficultyLeading, next.difficultySecondary);
    const prevL = this.settings.difficultyLeading;
    const addedLeadingZero = next.difficultyLeading > prevL;
    const prevZeroAt = this.networkStats && this.networkStats.lastRetarget
      && this.networkStats.lastRetarget.leadingZeroAt;
    this.networkStats.prevDifficulty = {
      leading: this.settings.difficultyLeading,
      secondary: this.settings.difficultySecondary
    };
    this.updateSettings(next);
    // Drop pre-retarget burst/stall samples so the next step and stall-ease
    // measure the new difficulty (stale 0.3s medians were blocking ease).
    this.networkStats.blockIntervals = [];
    this.networkStats.lastRetarget = {
      at: Date.now(),
      avgMs: avg,
      targetMs: targetMs,
      ratio: ratio,
      delta: nextScore - curScore,
      leading: next.difficultyLeading,
      secondary: next.difficultySecondary,
      addedLeadingZero: addedLeadingZero,
      leadingZeroAt: addedLeadingZero ? Date.now() : prevZeroAt
    };
    this.networkStats.averageBlockTimeMs = avg;
    return Object.assign({}, this.settings);
  }

  /**
   * If no block has landed for well over the target time, step difficulty down.
   * Otherwise a too-hard auto-retarget (5 zeros) leaves the class stuck forever
   * because rejected blocks never trigger another retarget.
   */
  maybeEaseDifficultyIfStalled() {
    if (!this.settings || !this.settings.autoDifficulty) return null;
    if (this.settings.parametersLocked) return null;

    const targetMs = this._targetMs();
    const lastRt = this.networkStats && this.networkStats.lastRetarget;
    const hs = Number(this.networkStats && this.networkStats.totalHashrate) || 0;
    const hashing = hs > 500;
    // Miners hashing + tip freeze: ease at ~12s (QT0G4E sat at 58s).
    // Empty hub keeps a longer wait so a brief pause does not collapse.
    const waitMs = hashing
      ? Math.max(targetMs * 1.2, 12000)
      : Math.max(targetMs * 2.5, 22000);
    // Prefer the wall-clock of the last accepted tip. lastBlockTime may be a
    // block.timestamp (or genesis Date.now()-10s) and lastRetarget.at ignores
    // blocks that landed after the last retarget — both toasted
    // "easing after a stall" at 12–13s while MYDFSN was still producing
    // multiple blocks per 10s.
    const tipIndex = this._canonicalTipIndex();
    this._syncStallWatch(tipIndex);
    const tipWall = this.networkStats && this.networkStats._lastTipWallClock;
    const lastBlk = this.networkStats && this.networkStats.lastBlockTime;
    const last = tipWall || lastBlk;
    const sinceTs = last || (lastRt && lastRt.at);
    const sinceMs = this.sinceLastBlockMs();
    const heightFreezeMs = this.networkStats && this.networkStats._stallWatchAt
      ? Date.now() - this.networkStats._stallWatchAt
      : 0;
    // Real freeze: no new canonical tip AND both wall clocks agree.
    // A stale _lastTipWallClock after hub reload (XU1J1S) must not look
    // like 27–34s while height is still climbing.
    const wallSince = lastBlk ? Date.now() - lastBlk : 0;
    if ((lastBlk && wallSince < waitMs) || (sinceTs && sinceMs < waitMs) || heightFreezeMs < waitMs) {
      return null;
    }
    if (!sinceTs && this.chain && this.chain.length <= 1) return null;

    const recent = Array.isArray(this.networkStats && this.networkStats.blockIntervals)
      ? this.networkStats.blockIntervals.slice(-6)
      : [];
    const recentMedian = this._medianMs(recent);
    const tipAge = tipWall
      ? Date.now() - tipWall
      : (last ? Date.now() - last : Infinity);
    // A tip that landed well under the 10s target is never a stall.
    if (tipAge < targetMs || heightFreezeMs < targetMs) return null;
    if (lastBlk && wallSince < targetMs) return null;
    // Still ≥3× too fast and a tip arrived within the 10s target: tighten
    // via maybeRetargetDifficulty, do not ease. Leftover 0.3s/2.1s samples
    // must not block ease on a true freeze (QT0G4E: 2.1s median, then 58s).
    if (recentMedian > 0 && recentMedian < targetMs / 3 && tipAge < targetMs) {
      return null;
    }
    if (recentMedian > 0 && recentMedian < targetMs * 0.8 && tipAge < waitMs) {
      return null;
    }

    const curL = Math.max(1, Math.min(6, Number(this.settings.difficultyLeading) || 1));
    const curS = Math.max(0, Math.min(15, Number(this.settings.difficultySecondary) || 0));
    const freezeMs = Math.max(targetMs * 2.5, 25000);
    const longFreeze = hashing
      && tipAge >= freezeMs
      && heightFreezeMs >= freezeMs
      && !!lastBlk
      && wallSince >= freezeMs;
    // Already at the easiest rung: keep asking the hub to republish the
    // tip so miners hashing a rejected fork remine (ST0R8T sat at 1+0xF
    // for 4+ minutes at 80k H/s). Do not toast another retarget.
    if (curL <= 1 && curS >= 15) {
      if (longFreeze && hashing) {
        return { republishTip: true, difficultyUnchanged: true };
      }
      return null;
    }

    // Reject storms can call this every packet. Keep nibble steps ~5s apart.
    if (lastRt && lastRt.stalled && lastRt.at && Date.now() - lastRt.at < 5000) {
      return null;
    }

    const wantL = this._wantLeadingFromHashrate();
    // MYDFSN h279: 4+0x3 toasted “easing after a stall, observed 12s”, then
    // the tip sat 455s at ~30kH/s. wantL≈4 blocked any L drop, so +2 S never
    // left the 4-zero band. A freeze well past 12s must drop a zero.
    // XU1J1S: a stale 27s sample dropped 4→3→2→1 while Miner 2 still
    // produced a new canonical block. Zero-drop needs a real tip freeze.
    // ST0R8T: 3→1 in ~22s — persist _stallZeroAt off lastRetarget so a
    // nibble/_commitRetarget cannot clear the ≥25s zero-drop cooldown.
    const lastStallZeroAt = (this.networkStats && this.networkStats._stallZeroAt)
      || (lastRt && lastRt.stallZeroAt)
      || 0;
    const stallZeroCooling = !!(lastStallZeroAt &&
      (Date.now() - lastStallZeroAt) < this._stallZeroCooldownMs());
    // Higher S = more permissive next nibble = easier. Score-1 walked
    // 5+0xC→0xB→0x1 (harder) and only recovered when it wrapped to 4+0xF.
    // ~12s path is nibble-only. Dropping a leading zero requires longFreeze
    // and the ≥25s zero-drop cooldown (no 3→1 in 22s, no wantL shortcut).
    let nextL = curL;
    let nextS = curS;
    if (longFreeze && curL > 1 && !stallZeroCooling) {
      nextL = curL - 1;
      nextS = Math.min(15, curS + 2);
    } else if (curS < 15) {
      nextS = Math.min(15, curS + 2);
    } else if (longFreeze && curL > 1 && !stallZeroCooling) {
      nextL = curL - 1;
      nextS = 15;
    }
    // Never jump more than one leading zero in a single ease.
    if (nextL < curL - 1) nextL = curL - 1;
    // Gentle 12s path stays within one zero of hashrate-implied L.
    // A ≥25s hashing freeze may drop further so the class is not stuck
    // at 4+0x3 for minutes (floor would return null at 3+0xF forever).
    if (!longFreeze && wantL != null && nextL < Math.max(1, wantL - 1)) {
      nextL = Math.max(1, wantL - 1);
      if (nextL === curL && nextS === curS) return null;
    }

    const next = {
      difficultyLeading: nextL,
      difficultySecondary: nextS
    };
    if (nextL === curL && nextS === curS) return null;

    const prevZeroAt = lastRt && lastRt.leadingZeroAt;
    this.networkStats.prevDifficulty = {
      leading: this.settings.difficultyLeading,
      secondary: this.settings.difficultySecondary
    };
    this.updateSettings(next);
    // Drop leftover burst samples so the first block after a freeze does
    // not look like 0.3s and immediately add a zero back.
    this.networkStats.blockIntervals = [];
    if (nextL < curL) {
      this.networkStats._stallZeroAt = Date.now();
    }
    this.networkStats.lastRetarget = {
      at: Date.now(),
      avgMs: sinceMs > 0 ? sinceMs : (recentMedian > 0 ? recentMedian : targetMs),
      targetMs: targetMs,
      ratio: sinceMs > 0 ? sinceMs / targetMs : 9,
      delta: -1,
      leading: next.difficultyLeading,
      secondary: next.difficultySecondary,
      stalled: true,
      addedLeadingZero: false,
      // Dropping a zero must not bounce straight back up (4→5→4).
      leadingZeroAt: nextL < curL ? Date.now() : prevZeroAt,
      stallZeroAt: nextL < curL ? Date.now() : lastStallZeroAt
    };
    return Object.assign({}, this.settings);
  }

  _pushBlockInterval(rawMs) {
    const interval = this._capIntervalMs(rawMs);
    if (!(interval > 0)) return;
    if (!Array.isArray(this.networkStats.blockIntervals)) this.networkStats.blockIntervals = [];
    this.networkStats.blockIntervals.push(interval);
    if (this.networkStats.blockIntervals.length > 20) {
      this.networkStats.blockIntervals = this.networkStats.blockIntervals.slice(-20);
    }
    this.networkStats.averageBlockTimeMs = this._medianMs(this.networkStats.blockIntervals);
  }

  /** Wall-clock sample on every canonical tip change (extension or reorg). */
  _recordTipPace() {
    const now = Date.now();
    const prevWall = this.networkStats && this.networkStats._lastTipWallClock;
    if (this.networkStats) {
      this.networkStats._lastTipWallClock = now;
      this.networkStats.lastBlockTime = now;
      this.networkStats._stallWatchHeight = this._canonicalTipIndex();
      this.networkStats._stallWatchAt = now;
    }
    if (!prevWall) return;
    if (this.chain && this.chain.length <= 2) return;
    const raw = now - prevWall;
    if (!(raw > 0)) return;
    this._pushBlockInterval(raw);
  }

  _recordBlockInterval(block) {
    const prev = this.chain.length >= 2 ? this.chain[this.chain.length - 2] : null;
    if (!prev || !block || !block.timestamp || !prev.timestamp) return;
    // Skip genesis→first (genesis timestamp is synthetic and skews the average)
    if (prev.miner === 'genesis' || prev.index === 0) return;

    const raw = Math.max(0, (block.timestamp || 0) - (prev.timestamp || 0));
    if (!(raw > 0)) return;
    this._pushBlockInterval(raw);
  }

  /**
   * Classroom starting coins (applied after each chain recompute via p.endowment).
   * Admin hub and student wallets get 100 so demos work without mining first.
   */
  static defaultEndowmentForRole(role) {
    const r = String(role || '').toLowerCase();
    if (r === 'wallet' || r === 'observer' || r === 'admin' || r === 'hub') return 100;
    return 0;
  }

  // Called when a new peer joins via the relay
  addOrUpdateParticipant(userId, role = 'miner', extra = {}) {
    extra = extra || {};
    if (!this.knownNames) this.knownNames = new Map();
    let incomingName = String(extra.displayName || extra.name || '').trim();
    if (incomingName && /^unnamed$/i.test(incomingName)) incomingName = '';
    // Empty hello after prune/reload must not drop a name we already applied.
    if (!incomingName) {
      incomingName = this.knownNames.get(String(userId)) || '';
    }
    // Never clobber a known classroom name with empty/null from a later join/hashrate packet
    if (!incomingName) {
      extra = Object.assign({}, extra);
      delete extra.name;
      delete extra.displayName;
    } else {
      extra = Object.assign({}, extra, { name: incomingName, displayName: incomingName });
    }
    if (!this.participants.has(userId)) {
      const endow = (extra.endowment != null)
        ? Math.max(0, Number(extra.endowment) || 0)
        : RelayBlockchainState.defaultEndowmentForRole(role);
      const row = {
        userId: userId,
        role: role,
        name: extra.name || null,
        displayName: extra.displayName || extra.name || null,
        hashrate: 0,
        blocksMined: 0,
        balance: endow,
        endowment: endow,
        joinedAt: Date.now(),
        lastSeenAt: Date.now(),
        status: 'idle'
      };
      Object.assign(row, extra);
      // Keep endowment authoritative after assign
      row.endowment = (extra.endowment != null)
        ? Math.max(0, Number(extra.endowment) || 0)
        : endow;
      if (extra.balance == null) row.balance = row.endowment;
      if (incomingName) this.knownNames.set(String(userId), incomingName);
      this.participants.set(userId, row);
    } else {
      const p = this.participants.get(userId);
      const existingName = String(p.displayName || p.name || '').trim();
      const existingIsPlaceholder = !existingName || /^unnamed$/i.test(existingName);
      // A later join / hello / hashrate for the same id must not rename a live
      // wallet (L3T0NE: Wallet 1's own page flipped to "Wallet 2").
      // Only an explicit Save Name (extra.rename) may replace a known name.
      // An empty first presence must not latch forever — a later real name wins.
      const allowRename = !!extra.rename || existingIsPlaceholder;
      const clean = Object.assign({}, extra);
      delete clean.rename;
      if (incomingName && !allowRename) {
        delete clean.name;
        delete clean.displayName;
      }
      Object.assign(p, clean);
      if (incomingName && allowRename) {
        p.name = incomingName;
        p.displayName = incomingName;
        this.knownNames.set(String(userId), incomingName);
      } else if (!p.displayName && p.name) {
        p.displayName = p.name;
      }
      p.lastSeenAt = Date.now();
      // Promote a known peer to wallet with starting coins if they never had an endowment
      const r = String(role || p.role || '').toLowerCase();
      if (
        (r === 'wallet' || r === 'observer') &&
        !(Number(p.endowment) > 0) &&
        extra.endowment == null
      ) {
        p.endowment = 100;
        p.role = role || p.role || 'wallet';
        p.balance = (Number(p.balance) || 0) + 100;
      } else if (role && !p.role) {
        p.role = role;
      }
    }
  }

  touchParticipant(userId) {
    const p = this.participants.get(userId);
    if (p) p.lastSeenAt = Date.now();
  }

  /**
   * Drop students who stopped heartbeating. A frozen positive hashrate is NOT
   * proof they are still here — phones leave the tab and the last report sticks.
   * `liveIds` must already be age-filtered (recent MQTT/WebRTC hellos only).
   */
  pruneStaleParticipants(liveIds, now) {
    now = now || Date.now();
    const STALE_HR_MS = 15000;
    const DROP_MS = 25000;
    const live = new Set();
    (liveIds || []).forEach(function (id) {
      if (id) live.add(String(id));
    });
    const drop = [];
    this.participants.forEach((p, id) => {
      if (!id || String(id).indexOf('probe-') === 0) {
        drop.push(id);
        return;
      }
      const r = String(p.role || '').toLowerCase();
      if (r === 'admin' || r === 'hub') return;
      if (live.has(String(id))) {
        // Presence already proves they are here. Do not rewrite lastSeenAt
        // — that stretched "gone" to ~45s (20s presence + 25s drop) and
        // left closed phone tabs listed forever at 0 H/s (MYDFSN).
        return;
      }
      const age = now - (p.lastSeenAt || p.joinedAt || 0);
      if (age > STALE_HR_MS) {
        p.hashrate = 0;
        if (p.status === 'mining') p.status = 'idle';
      }
      if (age > DROP_MS) drop.push(id);
    });
    drop.forEach((id) => this.participants.delete(id));
    if (drop.length || this.networkPaused) {
      let total = 0;
      this.participants.forEach((pp) => { total += (pp.hashrate || 0); });
      if (this.networkStats) this.networkStats.totalHashrate = this.networkPaused ? 0 : total;
    }
    return drop.length;
  }

  /** Pause time is not a mining stall — reset the ease clock on resume. */
  noteNetworkResumed() {
    if (!this.networkStats) this.networkStats = {};
    this.networkStats.lastBlockTime = Date.now();
    this.networkStats._lastTipWallClock = Date.now();
    if (this.networkStats.lastRetarget) this.networkStats.lastRetarget.at = Date.now();
  }

  /**
   * Merge a hub chain snapshot into a student's displayed canonical copy.
   * Compact MQTT payloads send only the last ~20 blocks; applying that as the
   * whole copy made heights jump backward (51→37, 36→23) and mixed orphans in.
   * Never adopt a shorter/older snapshot as the main list.
   */
  static mergeCanonicalCopy(local, incoming, meta) {
    local = Array.isArray(local) ? local.filter(Boolean) : [];
    incoming = Array.isArray(incoming) ? incoming.filter(Boolean) : [];
    meta = meta || {};
    const incomingTip = incoming.length ? incoming[incoming.length - 1] : null;
    const tipHash = meta.tipHash || (incomingTip && incomingTip.hash) || null;
    const tipIndex = (meta.tipIndex != null && !isNaN(Number(meta.tipIndex)))
      ? Number(meta.tipIndex)
      : ((meta.chainHeight != null && !isNaN(Number(meta.chainHeight)))
        ? Number(meta.chainHeight)
        : (incomingTip && incomingTip.index != null ? Number(incomingTip.index) : null));
    const truncated = !!meta.truncated;
    const confirmedHeight = (meta.confirmedHeight != null && !isNaN(Number(meta.confirmedHeight)))
      ? Number(meta.confirmedHeight)
      : null;
    const localTip = local.length ? local[local.length - 1] : null;
    const localTipIndex = (localTip && localTip.index != null)
      ? Number(localTip.index)
      : (local.length ? local.length - 1 : -1);
    // Fresh hub tip vs stale MQTT redelivery. A live tip at/above the height
    // we already confirmed means trim a private tail (474 vs hub 444). An
    // older tip below confirmedHeight is a redelivered compact window — keep
    // the longer genesis-rooted copy (51 vs stale 37).
    function isFreshHubTip() {
      return tipIndex != null && confirmedHeight != null && confirmedHeight > 0 && tipIndex >= confirmedHeight;
    }

    function isGenesisRooted(chain) {
      if (!chain || !chain.length) return false;
      const b = chain[0];
      return !!(b && (
        b.index === 0 ||
        b.miner === 'genesis' ||
        b.previousHash === '0' ||
        b.previousHash === '00'
      ));
    }

    function spliceSuffix(base, suffix) {
      if (!base.length || !suffix.length) return null;
      const byHash = new Map();
      base.forEach(function (b) { if (b && b.hash) byHash.set(b.hash, true); });
      for (let i = 0; i < suffix.length; i++) {
        const b = suffix[i];
        if (!b || !b.hash || !byHash.has(b.hash)) continue;
        const idx = base.findIndex(function (x) { return x && x.hash === b.hash; });
        if (idx >= 0) return base.slice(0, idx).concat(suffix.slice(i));
      }
      const first = suffix[0];
      if (first && first.previousHash && byHash.has(first.previousHash)) {
        const idx = base.findIndex(function (x) { return x && x.hash === first.previousHash; });
        if (idx >= 0) return base.slice(0, idx + 1).concat(suffix);
      }
      return null;
    }

    if (!incoming.length) {
      return { chain: local, applied: false, reason: 'empty-incoming', tipHash: tipHash, tipIndex: tipIndex };
    }

    // Hub tip hash is already on the copy.
    if (tipHash && local.some(function (b) { return b && b.hash === tipHash; })) {
      const idx = local.findIndex(function (b) { return b && b.hash === tipHash; });
      const extra = local.length - 1 - idx;
      // Stale compact/redelivery: old tip sits in the middle of a longer
      // genesis-rooted copy. Never roll the main list backward (51→37).
      if (
        extra > 1 &&
        tipIndex != null &&
        localTipIndex > tipIndex &&
        isGenesisRooted(local)
      ) {
        if (isFreshHubTip()) {
          return {
            chain: local.slice(0, idx + 1),
            applied: true,
            reason: 'trim-private-tail',
            tipHash: tipHash,
            tipIndex: tipIndex
          };
        }
        return { chain: local, applied: false, reason: 'stale-tip', tipHash: tipHash, tipIndex: tipIndex };
      }
      return {
        chain: local.slice(0, idx + 1),
        applied: extra > 0,
        reason: extra === 0 ? 'same-tip' : 'trim-private-tail',
        tipHash: tipHash,
        tipIndex: tipIndex
      };
    }

    // Stale compact / redelivered MQTT: older than the copy we already applied.
    if (
      tipIndex != null &&
      localTipIndex >= 0 &&
      tipIndex < localTipIndex &&
      isGenesisRooted(local)
    ) {
      if (isFreshHubTip()) {
        const splicedFresh = spliceSuffix(local, incoming);
        if (splicedFresh && splicedFresh.length) {
          return { chain: splicedFresh, applied: true, reason: 'spliced-suffix', tipHash: tipHash, tipIndex: tipIndex };
        }
        const trimmed = local.filter(function (b) {
          return b && (b.index == null || Number(b.index) <= tipIndex);
        });
        if (trimmed.length) {
          return { chain: trimmed, applied: true, reason: 'trim-private-tail', tipHash: tipHash, tipIndex: tipIndex };
        }
      }
      return { chain: local, applied: false, reason: 'stale-tip', tipHash: tipHash, tipIndex: tipIndex };
    }

    const incomingRooted = isGenesisRooted(incoming);
    if (incomingRooted && !truncated) {
      return { chain: incoming.slice(), applied: true, reason: 'full-replace', tipHash: tipHash, tipIndex: tipIndex };
    }
    if (incomingRooted && truncated && incoming.length >= local.length) {
      return { chain: incoming.slice(), applied: true, reason: 'full-replace', tipHash: tipHash, tipIndex: tipIndex };
    }

    const spliced = spliceSuffix(local, incoming);
    if (spliced && spliced.length) {
      return { chain: spliced, applied: true, reason: 'spliced-suffix', tipHash: tipHash, tipIndex: tipIndex };
    }

    // Late joiner (no local copy yet): show the hub window, height comes from tipIndex.
    if (!local.length) {
      return { chain: incoming.slice(), applied: true, reason: 'late-join-window', tipHash: tipHash, tipIndex: tipIndex };
    }

    // Private/optimistic local fork and a newer hub window that does not overlap:
    // adopt the hub window so the copy follows the instructor, never a shorter reorg.
    if (tipIndex != null && tipIndex > localTipIndex) {
      return { chain: incoming.slice(), applied: true, reason: 'hub-window-ahead', tipHash: tipHash, tipIndex: tipIndex };
    }

    // Cannot connect and incoming is not ahead — keep the current copy.
    return { chain: local, applied: false, reason: 'keep-local', tipHash: tipHash, tipIndex: tipIndex };
  }

  /**
   * One number for miner Overview Block Height and "Your Blockchain Copy".
   * JQQC4D Miner 2: Overview 406 vs Copy 395, then Overview 444 vs Copy 474.
   * Copy must not read 10–30 ahead of the hub; Overview must not race ahead
   * of the painted copy. Optimistic hub+1 is allowed (±1).
   */
  static studentMinerPairedHeight(chain, hubHeight) {
    const copyTip = RelayBlockchainState.copyTipIndex(chain);
    const hub = (hubHeight != null && !isNaN(Number(hubHeight))) ? Number(hubHeight) : 0;
    const copy = copyTip != null ? Number(copyTip) : 0;
    if (hub > 0 && copy > hub + 1) return hub;
    if (copy > 0 && hub > copy + 1) return copy;
    if (copy > 0) return copy;
    return Math.max(hub, 0);
  }

  /** Display height for a (possibly truncated) student copy. Never use length-1 of a suffix. */
  static canonicalCopyHeight(chain, meta) {
    meta = meta || {};
    const copyTip = RelayBlockchainState.copyTipIndex(chain);
    if (meta.tipIndex != null && !isNaN(Number(meta.tipIndex))) {
      const t = Number(meta.tipIndex);
      // Compact last-20 windows have length-1 ≈ 19 while block.index is 45+.
      if (copyTip == null || t >= copyTip || !RelayBlockchainState._looksLikeSuffixLength(chain, t)) {
        return Math.max(t, copyTip || 0);
      }
    }
    if (meta.chainHeight != null && !isNaN(Number(meta.chainHeight))) {
      const t = Number(meta.chainHeight);
      if (copyTip == null || t >= copyTip || !RelayBlockchainState._looksLikeSuffixLength(chain, t)) {
        return Math.max(t, copyTip || 0);
      }
    }
    if (meta.hubHeight != null && !isNaN(Number(meta.hubHeight))) {
      const t = Number(meta.hubHeight);
      if (copyTip == null || t >= copyTip || !RelayBlockchainState._looksLikeSuffixLength(chain, t)) {
        return Math.max(t, copyTip || 0);
      }
    }
    if (copyTip != null) return copyTip;
    return 0;
  }

  /** Last painted block.index. Null if the copy is empty or lacks index. */
  static copyTipIndex(chain) {
    const tip = Array.isArray(chain) && chain.length ? chain[chain.length - 1] : null;
    if (tip && tip.index != null && !isNaN(Number(tip.index))) return Number(tip.index);
    return null;
  }

  /**
   * True when `value` is the array length-1 of a compact suffix, not a real
   * hub height. CVV1U8 wallets showed Overview 22/28/31 while the panel tip
   * was 45/46/51 — a persistent ~20-block gap, the last-20 transport window.
   */
  static _looksLikeSuffixLength(chain, value) {
    if (!Array.isArray(chain) || !chain.length) return false;
    const n = Number(value);
    if (isNaN(n)) return false;
    const suffixLen = chain.length - 1;
    const copyTip = RelayBlockchainState.copyTipIndex(chain);
    if (copyTip == null) return n === suffixLen;
    return n === suffixLen && copyTip > n + 1;
  }

  /**
   * Network Overview height must equal the painted copy tip / hub tip.
   * Never use chain.length-1 or a stale networkStats.blockHeight — those
   * stayed ~20 behind on CVV1U8 (22→45, 28→51) and never converged.
   */
  static resolveOverviewHeight(chain, meta, previousHeight) {
    meta = meta || {};
    const nums = [];
    function push(v) {
      if (v == null || v === '') return;
      const n = Number(v);
      if (!isNaN(n) && isFinite(n) && n >= 0) nums.push(n);
    }
    const copyTip = RelayBlockchainState.copyTipIndex(chain);
    push(copyTip);

    function pushHub(v) {
      if (v == null || v === '') return;
      if (RelayBlockchainState._looksLikeSuffixLength(chain, v)) return;
      push(v);
    }
    pushHub(meta.tipIndex);
    pushHub(meta.chainHeight);
    pushHub(meta.hubHeight);
    pushHub(meta.newHeight);
    // networkStats.blockHeight is chain.length-1 on the hub. When a stale
    // snapshot rides along with a last-20 window it is ~20 behind the panel.
    // Only use it when we have no copy tip and it is not a suffix length.
    if (copyTip == null && meta.networkStats) {
      pushHub(meta.networkStats.blockHeight);
    }
    if (copyTip == null) pushHub(meta.blockHeight);
    push(previousHeight);
    if (!nums.length) return 0;
    return Math.max.apply(null, nums);
  }

  /**
   * Stronger half of live miners by hashrate. Team 51% is only honest if that
   * half actually has more than 50% of miner hashrate (and someone is hashing).
   */
  static collusionTeamHashrate(participants) {
    const miners = (participants || []).filter(function (p) {
      if (!p) return false;
      const id = p.userId || p.id || '';
      if (!id || String(id).indexOf('probe-') === 0) return false;
      const role = String(p.role || 'miner').toLowerCase();
      return role !== 'admin' && role !== 'wallet' && role !== 'observer' && role !== 'hub';
    });
    const n = miners.length;
    const totalHr = miners.reduce(function (sum, p) { return sum + (Number(p.hashrate) || 0); }, 0);
    const ranked = miners.slice().sort(function (a, b) {
      return (Number(b.hashrate) || 0) - (Number(a.hashrate) || 0);
    });
    const teamN = Math.max(1, Math.ceil(n / 2));
    const team = ranked.slice(0, teamN);
    const teamHr = team.reduce(function (sum, p) { return sum + (Number(p.hashrate) || 0); }, 0);
    const share = totalHr > 0 ? teamHr / totalHr : 0;
    return { n: n, teamN: teamN, teamHr: teamHr, totalHr: totalHr, share: share };
  }

  /**
   * Walk parent links back to genesis. Returns null if the path is incomplete.
   */
  _pathToGenesis(tipHash) {
    if (!tipHash || !this.allBlocks.has(tipHash)) return null;
    const genesisHash = this.chain[0] && this.chain[0].hash;
    const path = [];
    const seen = new Set();
    let cur = this.allBlocks.get(tipHash);

    while (cur) {
      if (seen.has(cur.hash)) return null;
      seen.add(cur.hash);
      path.unshift(cur);

      const isGenesis =
        cur.index === 0 ||
        cur.previousHash === '0' ||
        cur.miner === 'genesis' ||
        (genesisHash && cur.hash === genesisHash);
      if (isGenesis) {
        if (genesisHash && cur.hash !== genesisHash) return null;
        return path;
      }

      cur = this.allBlocks.get(cur.previousHash);
      if (!cur) return null;
    }
    return null;
  }

  /**
   * True if path is valid as the classroom "main" (classic) chain during a hard fork.
   * After activation height, main must not include NEW-tagged blocks — those stay as
   * permanent orphans so the demo shows two parallel chains instead of a reorg.
   */
  _isClassicMainPath(path) {
    if (!path || !path.length) return false;
    if (!this.pendingFork || this.pendingFork.height == null) return true;
    const act = Number(this.pendingFork.height);
    for (let i = 0; i < path.length; i++) {
      const b = path[i];
      if (!b || b.index == null) continue;
      if (Number(b.index) < act) continue;
      const fid = b.forkId || 'classic';
      if (fid === 'new' || fid === 'NEW') return false;
    }
    return true;
  }

  /**
   * Longest-chain fork choice. Equal height → keep the current tip (first-seen wins).
   *
   * During a hard-fork simulation, main is restricted to classic-compatible paths so
   * the NEW side never "wins" via pure length and erases the permanent split.
   */
  /**
   * Drop race-loser blocks that are far behind the tip so the hub Map and
   * projector cannot grow without bound (admin Aw Snap at height 264+).
   * Keeps the canonical chain plus recent orphans for short 51% / reorg demos.
   */
  pruneDistantOrphans(keepBehind) {
    keepBehind = keepBehind == null ? 32 : Math.max(8, Number(keepBehind) || 32);
    const tip = this.chain && this.chain.length ? this.chain[this.chain.length - 1] : null;
    const tipIndex = tip && tip.index != null
      ? Number(tip.index)
      : (this.chain && this.chain.length ? this.chain.length - 1 : 0);
    if (!(tipIndex > keepBehind)) return 0;
    const mainHashes = new Set();
    (this.chain || []).forEach(function (b) {
      if (b && b.hash) mainHashes.add(b.hash);
    });
    const drop = [];
    this.allBlocks.forEach((b, hash) => {
      if (!b || !hash || mainHashes.has(hash)) return;
      if (b.miner === 'genesis' || b.index === 0) return;
      const idx = b.index != null ? Number(b.index) : -1;
      if (idx >= 0 && tipIndex - idx > keepBehind) drop.push(hash);
    });
    drop.forEach((h) => this.allBlocks.delete(h));
    return drop.length;
  }

  _blocksForPersist() {
    if (typeof this.pruneDistantOrphans === 'function') this.pruneDistantOrphans(32);
    return Array.from(this.allBlocks.values());
  }

  _selectBestChain() {
    const hardFork = !!(this.pendingFork && this.pendingFork.height != null);
    let best = [];

    // Seed with current chain only if it still qualifies (don't lock onto a NEW tip)
    if (this.chain && this.chain.length) {
      if (!hardFork || this._isClassicMainPath(this.chain)) {
        best = this.chain.slice();
      }
    }

    this.allBlocks.forEach((_block, hash) => {
      const path = this._pathToGenesis(hash);
      if (!path || path.length === 0) return;
      if (hardFork && !this._isClassicMainPath(path)) return;
      if (path.length > best.length) {
        best = path;
      }
      // Equal length: keep existing tip (stable / first-seen)
    });

    // Fallback if hard-fork filter left us empty (e.g. only NEW blocks exist yet)
    if (!best.length) {
      this.allBlocks.forEach((_block, hash) => {
        const path = this._pathToGenesis(hash);
        if (!path || path.length === 0) return;
        if (path.length > best.length) best = path;
      });
    }

    return best;
  }

  /** Content fingerprint: same send even if a miner dropped or restamped `id`. */
  _txContentKey(tx) {
    if (!tx) return '';
    const from = String(tx.from || '');
    const to = String(tx.to || '');
    const amt = String(Number(tx.amount));
    const ts = String(tx.timestamp || '');
    if (!from || !to || !ts || !(Number(tx.amount) > 0)) return '';
    return from + ':' + to + ':' + amt + ':' + ts;
  }

  /** Stable id for a transfer (used for mempool + double-include checks). */
  _txKey(tx) {
    if (!tx) return '';
    if (tx.id) return String(tx.id);
    return this._txContentKey(tx);
  }

  /** Every identity we treat as "this transfer" — id and content fingerprint. */
  _txAllKeys(tx) {
    const keys = [];
    if (!tx) return keys;
    if (tx.id) keys.push(String(tx.id));
    const content = this._txContentKey(tx);
    if (content) keys.push(content);
    return keys;
  }

  _addTxKeys(set, tx) {
    this._txAllKeys(tx).forEach(function (k) { if (k) set.add(k); });
  }

  _txMatchesSet(tx, set) {
    if (!set || !set.size) return false;
    const keys = this._txAllKeys(tx);
    for (let i = 0; i < keys.length; i++) {
      if (set.has(keys[i])) return true;
    }
    return false;
  }

  /** All transaction keys already present on the current canonical chain. */
  _confirmedTxIds() {
    const ids = new Set();
    (this.chain || []).forEach((block) => {
      const txs = (block && Array.isArray(block.transactions)) ? block.transactions : [];
      txs.forEach((tx) => this._addTxKeys(ids, tx));
    });
    return ids;
  }

  /**
   * Confirmed tx keys relevant to validating `block`.
   * Same-side only after hard-fork activation so the two chains stay independent.
   */
  _confirmedTxIdsForBlock(block) {
    const act =
      this.pendingFork && this.pendingFork.height != null
        ? Number(this.pendingFork.height)
        : null;
    const fid = (block && block.forkId) || 'classic';
    const isNew = fid === 'new' || fid === 'NEW';
    const bIndex = block && block.index != null ? Number(block.index) : null;

    // Pre-fork or no fork: whole canonical chain
    if (act == null || bIndex == null || bIndex < act) {
      return this._confirmedTxIds();
    }

    const ids = new Set();
    // Shared history below activation is common to both sides
    (this.chain || []).forEach((b) => {
      if (!b) return;
      if (b.index != null && Number(b.index) >= act) return; // skip post-act main (classic)
      const txs = Array.isArray(b.transactions) ? b.transactions : [];
      txs.forEach((tx) => this._addTxKeys(ids, tx));
    });

    // Same-side post-activation blocks only
    this.allBlocks.forEach((b) => {
      if (!b || b.index == null || Number(b.index) < act) return;
      const bf = b.forkId || 'classic';
      const bNew = bf === 'new' || bf === 'NEW';
      if (bNew !== isNew) return;
      const txs = Array.isArray(b.transactions) ? b.transactions : [];
      txs.forEach((tx) => this._addTxKeys(ids, tx));
    });
    return ids;
  }

  blockSubsidyAt(height) {
    const s = this.settings || {};
    const base = Number(s.miningRewardCoins);
    if (s.chainFlavor !== 'bitcoin') return isNaN(base) ? 10 : base;
    const start = isNaN(base) ? 50 : base;
    const interval = Math.max(1, Number(s.halvingInterval) || 21);
    const h = Math.max(0, Number(height) || 0);
    const halvings = Math.floor(h / interval);
    if (halvings >= 64) return 0;
    return start / Math.pow(2, halvings);
  }

  /**
   * Recompute balances from the canonical chain:
   * mining rewards + all included transfers.
   */
  _recomputeMiningRewards() {
    this.participants.forEach((p) => {
      p.blocksMined = 0;
      p.balance = 0;
    });

    const seenTx = new Set();
    this.chain.forEach((block) => {
      if (!block) return;

      if (block.miner && block.miner !== 'genesis') {
        const minerId = block.miner;
        if (!this.participants.has(minerId)) {
          this.addOrUpdateParticipant(minerId, 'miner');
        }
        const miner = this.participants.get(minerId);
        miner.blocksMined = (miner.blocksMined || 0) + 1;
        const height = block.index != null ? Number(block.index) : 0;
        miner.balance = (miner.balance || 0) + this.blockSubsidyAt(height);
      }

      const txs = Array.isArray(block.transactions) ? block.transactions : [];
      txs.forEach((tx) => {
        if (!tx) return;
        const from = tx.from;
        const to = tx.to;
        const amount = Number(tx.amount);
        if (!from || !to || !(amount > 0)) return;
        // Same tx can race into two blocks (different ids) — credit once
        if (this._txMatchesSet(tx, seenTx)) return;
        this._addTxKeys(seenTx, tx);

        if (!this.participants.has(from)) {
          this.addOrUpdateParticipant(from, 'wallet', { balance: 0 });
        }
        if (!this.participants.has(to)) {
          this.addOrUpdateParticipant(to, 'wallet', { balance: 0 });
        }
        const sender = this.participants.get(from);
        const recipient = this.participants.get(to);
        sender.balance = (sender.balance || 0) - amount;
        recipient.balance = (recipient.balance || 0) + amount;
      });
    });

    // Classroom demo: admin + wallets carry a starting endowment (default 100)
    // so students can send coins without mining first. Applied after chain replay.
    this.participants.forEach((p) => {
      let endow = Number(p.endowment) || 0;
      // Backfill wallets that joined before endowment existed
      if (!endow) {
        const r = String(p.role || '').toLowerCase();
        if (r === 'wallet' || r === 'observer' || r === 'admin' || r === 'hub') {
          endow = 100;
          p.endowment = 100;
        }
      }
      if (endow > 0) {
        p.balance = (p.balance || 0) + endow;
      }
    });
  }

  // Main entry point: a miner submitted a block via the relay
  // Returns { accepted, reason?, newHeight?, isFork?, reorg?, tipChanged?, chain? }
  tryAddBlock(block, fromUserId) {
    if (!block || !block.hash || !block.previousHash) {
      return { accepted: false, reason: 'Malformed block' };
    }

    // Idempotent: MQTT/BroadcastChannel can deliver the same block twice.
    // Treat as a quiet success so miners don't get "Block rejected: Duplicate block" toasts.
    if (this.allBlocks.has(block.hash)) {
      const tip = this.chain[this.chain.length - 1] || null;
      return {
        accepted: true,
        duplicate: true,
        tipChanged: false,
        isFork: !(tip && tip.hash === block.hash) && !this.chain.some((b) => b.hash === block.hash),
        reorg: false,
        newHeight: Math.max(0, this.chain.length - 1),
        chain: this.chain.slice()
      };
    }

    // PoW check: leading zeros + secondary hex nibble (matches miner isValidHash)
    const leading = (this.settings.difficultyLeading != null) ? this.settings.difficultyLeading : 3;
    const secondary = (this.settings.difficultySecondary != null) ? this.settings.difficultySecondary : 8;
    const meetsNow = this.hashMeetsDifficulty(block.hash, leading, secondary);
    const prev = this.networkStats && this.networkStats.prevDifficulty;
    const retargetAt = this.networkStats && this.networkStats.lastRetarget && this.networkStats.lastRetarget.at;
    const recentRetarget = !!(retargetAt && Date.now() - retargetAt < 20000);
    const meetsPrev = !!(prev && this.hashMeetsDifficulty(block.hash, prev.leading, prev.secondary));
    if (!meetsNow && !(recentRetarget && meetsPrev)) {
      return {
        accepted: false,
        reason: `Block does not meet difficulty (needs ${leading} leading zeros)`,
        difficultyLeading: leading,
        difficultySecondary: secondary,
        chain: this.chain.slice(),
        newHeight: Math.max(0, this.chain.length - 1),
        tipHash: this.chain.length ? this.chain[this.chain.length - 1].hash : null,
        tipIndex: this.chain.length ? this.chain[this.chain.length - 1].index : 0
      };
    }

    this.ensureGenesis();

    // Hard-fork rules: keep classic and NEW sides from crossing after activation
    if (this.pendingFork && this.pendingFork.height != null) {
      const act = Number(this.pendingFork.height);
      const fid = block.forkId || 'classic';
      const isNew = fid === 'new' || fid === 'NEW';
      const parent = this.allBlocks.get(block.previousHash) ||
        (this.chain && this.chain.find(function (b) { return b && b.hash === block.previousHash; }));
      const parentFid = parent ? (parent.forkId || 'classic') : 'classic';
      const parentIsNew = parentFid === 'new' || parentFid === 'NEW';
      const bIndex = block.index != null ? Number(block.index) : null;

      if (bIndex != null && bIndex < act) {
        // Pre-activation: reject NEW-tagged blocks (they cause orphan spam)
        if (isNew) {
          return {
            accepted: false,
            reason: 'Hard fork not active yet (activation at #' + act + ')',
            chain: this.chain.slice(),
            newHeight: Math.max(0, this.chain.length - 1)
          };
        }
      } else if (bIndex != null && bIndex >= act) {
        if (isNew) {
          // NEW must extend another NEW tip, or the classic activation parent (index act-1)
          if (parent) {
            const okFromNew = parentIsNew;
            const okFirst = !parentIsNew && parent.index === act - 1 && bIndex === act;
            if (!okFromNew && !okFirst) {
              return {
                accepted: false,
                reason: 'NEW fork must extend activation parent (#' + (act - 1) + ') or a NEW tip',
                chain: this.chain.slice(),
                newHeight: Math.max(0, this.chain.length - 1)
              };
            }
          }
        } else {
          // Classic post-activation cannot build on NEW blocks
          if (parentIsNew) {
            return {
              accepted: false,
              reason: 'Classic chain cannot extend a NEW-fork block',
              chain: this.chain.slice(),
              newHeight: Math.max(0, this.chain.length - 1)
            };
          }
        }
      }
    }

    // Reject blocks that re-include transfers already confirmed on the *same fork side*.
    // During a hard fork, classic and NEW are permanent parallel histories — a transfer
    // on classic must not block the same transfer on NEW (and vice versa).
    const confirmed = this._confirmedTxIdsForBlock(block);
    const blockTxs = Array.isArray(block.transactions) ? block.transactions : [];
    const seenInBlock = new Set();
    for (let i = 0; i < blockTxs.length; i++) {
      const tx = blockTxs[i];
      if (this._txMatchesSet(tx, confirmed)) {
        return {
          accepted: false,
          reason: 'Duplicate transaction already on chain',
          chain: this.chain.slice(),
          newHeight: Math.max(0, this.chain.length - 1)
        };
      }
      if (this._txMatchesSet(tx, seenInBlock)) {
        return {
          accepted: false,
          reason: 'Duplicate transaction within block',
          chain: this.chain.slice(),
          newHeight: Math.max(0, this.chain.length - 1)
        };
      }
      this._addTxKeys(seenInBlock, tx);
    }

    const oldTip = this.chain[this.chain.length - 1] || null;
    const oldChain = this.chain.slice();

    if (!this.allBlocks.has(block.previousHash) && block.previousHash !== '0') {
      console.warn('[RelayState] Block parent not yet known — storing as orphan until parent arrives');
    }

    // Sleeping phones keep hashing a stale parent. Accepting those as orphans
    // floods the projector and the phone never follows the real tip.
    // Same-height races and short classroom 51% forks (default 2 back) still pass.
    if (
      oldTip &&
      block.previousHash !== '0' &&
      block.previousHash !== oldTip.hash &&
      !(this.pendingFork && this.pendingFork.height != null)
    ) {
      const parent = this.allBlocks.get(block.previousHash) ||
        (this.chain && this.chain.find(function (b) { return b && b.hash === block.previousHash; }));
      if (parent) {
        const parentIndex = parent.index != null ? Number(parent.index) : -1;
        const tipIndex = oldTip.index != null ? Number(oldTip.index) : Math.max(0, this.chain.length - 1);
        if (parentIndex >= 0 && tipIndex - parentIndex > 4) {
          return {
            accepted: false,
            reason: 'Stale parent — mine on the current hub tip',
            chain: this.chain.slice(),
            newHeight: tipIndex,
            tipHash: oldTip.hash,
            tipIndex: tipIndex
          };
        }
      }
    }

    // First-seen stays the tip at equal height (`_selectBestChain`). Still
    // store ONE competing sibling so a later extension can reorg — otherwise
    // a race that later loses (#30 with a transfer, then a longer empty fork)
    // can never be unwound and the transfer vanishes. Extra remine-spam
    // beyond two blocks at the same parent+index+fork is dropped.
    const slotFid = block.forkId || 'classic';
    const slotIndex = block.index != null ? Number(block.index) : null;
    if (slotIndex != null) {
      let siblingCount = 0;
      this.allBlocks.forEach((existing) => {
        if (!existing) return;
        if (existing.hash === block.hash) return;
        if (String(existing.previousHash) !== String(block.previousHash)) return;
        if (Number(existing.index) !== slotIndex) return;
        if ((existing.forkId || 'classic') !== slotFid) return;
        siblingCount += 1;
      });
      if (siblingCount >= 2) {
        return {
          accepted: false,
          reason: 'Stale block — already have #' + slotIndex + ' on this parent',
          chain: this.chain.slice(),
          newHeight: Math.max(0, this.chain.length - 1)
        };
      }
    }

    this.allBlocks.set(block.hash, Object.assign({}, block, {
      miner: block.miner || fromUserId || block.miner
    }));

    if (fromUserId && !this.participants.has(fromUserId)) {
      this.addOrUpdateParticipant(fromUserId, 'miner');
    }

    // Direct tip extension: skip the O(n) walk of every stored hash. At
    // height 200+ with 3–4 racing miners that walk OOMs the admin tab.
    let bestChain;
    const stored = this.allBlocks.get(block.hash);
    const storedIdx = stored && stored.index != null ? Number(stored.index) : NaN;
    const oldIdx = oldTip && oldTip.index != null ? Number(oldTip.index) : NaN;
    if (
      !(this.pendingFork && this.pendingFork.height != null) &&
      oldTip &&
      stored &&
      stored.previousHash === oldTip.hash &&
      !isNaN(storedIdx) &&
      !isNaN(oldIdx) &&
      storedIdx === oldIdx + 1
    ) {
      bestChain = this.chain.concat([stored]);
    } else {
      bestChain = this._selectBestChain();
    }
    const newTip = bestChain[bestChain.length - 1] || null;
    const tipChanged = !!(newTip && (!oldTip || oldTip.hash !== newTip.hash));
    const isDirectExtension = !!(oldTip && newTip && newTip.previousHash === oldTip.hash);
    const didReorg = tipChanged && !isDirectExtension;
    const onBest = bestChain.some((b) => b.hash === block.hash);

    this.chain = bestChain;
    const heightTip = this.chain[this.chain.length - 1];
    this.networkStats.blockHeight = (heightTip && heightTip.index != null)
      ? Number(heightTip.index)
      : Math.max(0, this.chain.length - 1);
    if (newTip && tipChanged) {
      // Wall-clock between tip changes. Block timestamps collide when 3 miners
      // find 1-zero hashes in the same ms, and reorgs skipped interval samples
      // so auto-diff only nudged twice in a 200-block burst.
      this._recordTipPace();
    }
    // Do not rewind lastBlockTime to newTip.timestamp on a duplicate / non-tip
    // delivery — that made a live chain look 12s+ stalled (false stall-ease).

    this._recomputeMiningRewards();
    if (typeof this.pruneDistantOrphans === 'function') {
      this.pruneDistantOrphans(32);
    }

    // If a confirmed transfer's block lost the race, put it back in the
    // mempool (or drop it with a reason if it is invalid on the new tip).
    let requeuedTransactions = [];
    let droppedTransactions = [];
    if (didReorg) {
      const rq = this._requeueOrphanedTransactions(oldChain, this.chain);
      requeuedTransactions = rq.restored || [];
      droppedTransactions = rq.dropped || [];
    }

    // Drop confirmed mempool txs whenever the canonical tip moves
    if (onBest) {
      if (typeof this.clearIncludedTransactions === 'function') {
        this.clearIncludedTransactions(block);
      }
      if (typeof this.purgeConfirmedFromMempool === 'function') {
        this.purgeConfirmedFromMempool();
      }
    }

    // Classroom pacing: retarget difficulty toward target block time
    let retargetSettings = null;
    if (onBest && tipChanged && typeof this.maybeRetargetDifficulty === 'function') {
      retargetSettings = this.maybeRetargetDifficulty();
    }

    const tipOut = this.chain[this.chain.length - 1] || newTip;
    return {
      accepted: true,
      newHeight: Math.max(0, this.chain.length - 1),
      isFork: !onBest,
      reorg: didReorg,
      tipChanged: tipChanged,
      chain: this.chain.slice(),
      tipHash: tipOut && tipOut.hash,
      tipIndex: tipOut && tipOut.index != null ? tipOut.index : Math.max(0, this.chain.length - 1),
      retargetSettings: retargetSettings,
      requeuedTransactions: requeuedTransactions,
      droppedTransactions: droppedTransactions
    };
  }

  compactChainForTransport(maxBytes) {
    maxBytes = maxBytes || 70000;
    const chain = Array.isArray(this.chain) ? this.chain : [];
    const tip = chain.length ? chain[chain.length - 1] : null;
    const meta = {
      chainHeight: tip && tip.index != null ? tip.index : Math.max(0, chain.length - 1),
      tipHash: tip && tip.hash,
      tipIndex: tip && tip.index != null ? tip.index : Math.max(0, chain.length - 1)
    };
    // Height 28+ classroom chains exceed the MQTT budget; skip JSON.stringify
    // of the full array on every join / reorg (0HU8XV Aw Snap allocation path).
    if (chain.length > 28) {
      return Object.assign({ chain: chain.slice(-20), chainTruncated: true }, meta);
    }
    let size = 0;
    try { size = JSON.stringify(chain).length; } catch (e) { size = 999999; }
    if (size <= maxBytes) return Object.assign({ chain: chain, chainTruncated: false }, meta);
    return Object.assign({ chain: chain.slice(-20), chainTruncated: true }, meta);
  }
  tryAddTransaction(tx) {
    if (!tx) return { accepted: false, reason: 'Empty transaction' };
    // Normalize shape
    const normalized = {
      from: tx.from,
      to: tx.to,
      amount: Number(tx.amount),
      timestamp: tx.timestamp || Date.now(),
      id: tx.id || (String(tx.from || '') + ':' + String(tx.to || '') + ':' + String(tx.timestamp || Date.now()))
    };
    if (!normalized.from || !normalized.to || !(normalized.amount > 0)) {
      return { accepted: false, reason: 'Invalid transaction' };
    }
    // Already confirmed on chain — never re-enter mempool
    if (this._txMatchesSet(normalized, this._confirmedTxIds())) {
      return { accepted: false, reason: 'Transaction already confirmed' };
    }
    // Dedupe in mempool
    if (this.pendingTransactions.some((t) => this._txMatchesSet(normalized, new Set(this._txAllKeys(t))))) {
      return { accepted: true, duplicate: true };
    }
    this.pendingTransactions.push(normalized);
    this.networkStats.totalTransactions = (this.networkStats.totalTransactions || 0) + 1;
    return { accepted: true, transaction: normalized };
  }

  /** Remove mempool txs that were included in a newly accepted block */
  clearIncludedTransactions(block) {
    if (!block || !Array.isArray(block.transactions) || block.transactions.length === 0) {
      return;
    }
    const keys = new Set();
    block.transactions.forEach((t) => this._addTxKeys(keys, t));
    this.pendingTransactions = this.pendingTransactions.filter((t) => !this._txMatchesSet(t, keys));
  }

  /** Drop any mempool entry that already appears anywhere on the canonical chain. */
  purgeConfirmedFromMempool() {
    const confirmed = this._confirmedTxIds();
    if (!confirmed.size) return;
    this.pendingTransactions = this.pendingTransactions.filter((t) => !this._txMatchesSet(t, confirmed));
  }

  /**
   * After a reorg, restore transfers that were only in orphaned blocks.
   * Spendability is checked against the new canonical balances plus anything
   * already sitting in the mempool (applied in original order).
   *
   * GHPEHS Miner 2 (`user_x64uho1mu`): Wallet 1 → Miner 2 for 5 landed once
   * (55 = 5×10+5, then 75 = 7×10+5, never +10). A later reorg dropped them
   * to 2 blocks / 20 coins (exactly 2×10) with mempool 0 and every remaining
   * main-chain block Txs 0. The including block left the canonical chain;
   * this puts that single transfer back pending unless it is invalid now.
   */
  _requeueOrphanedTransactions(oldChain, newChain) {
    const restored = [];
    const dropped = [];
    const newHashes = new Set();
    (newChain || []).forEach(function (b) {
      if (b && b.hash) newHashes.add(b.hash);
    });
    const orphaned = (oldChain || []).filter(function (b) {
      return !!(b && b.hash && !newHashes.has(b.hash) && b.miner !== 'genesis');
    });
    if (!orphaned.length) return { restored: restored, dropped: dropped };

    const confirmed = this._confirmedTxIds();
    const inPool = new Set();
    (this.pendingTransactions || []).forEach((t) => this._addTxKeys(inPool, t));

    const candidates = [];
    const seenCand = new Set();
    orphaned.forEach((block) => {
      const txs = (block && Array.isArray(block.transactions)) ? block.transactions : [];
      txs.forEach((tx) => {
        if (!tx || !(Number(tx.amount) > 0) || !tx.from || !tx.to) return;
        if (this._txMatchesSet(tx, confirmed)) return;
        if (this._txMatchesSet(tx, inPool) || this._txMatchesSet(tx, seenCand)) return;
        this._addTxKeys(seenCand, tx);
        candidates.push({
          from: tx.from,
          to: tx.to,
          amount: Number(tx.amount),
          timestamp: tx.timestamp || Date.now(),
          id: tx.id || (String(tx.from || '') + ':' + String(tx.to || '') + ':' + String(tx.timestamp || Date.now()))
        });
      });
    });

    const reserved = {};
    (this.pendingTransactions || []).forEach(function (t) {
      if (!t || !t.from) return;
      reserved[t.from] = (reserved[t.from] || 0) + Number(t.amount || 0);
    });

    candidates.forEach((tx) => {
      const sender = this.participants.get(tx.from);
      const bal = sender ? (Number(sender.balance) || 0) : 0;
      const used = reserved[tx.from] || 0;
      if (bal - used >= tx.amount) {
        this.pendingTransactions.push(tx);
        reserved[tx.from] = used + tx.amount;
        restored.push(tx);
      } else {
        dropped.push({
          transaction: tx,
          reason: 'insufficient-balance'
        });
      }
    });
    return { restored: restored, dropped: dropped };
  }

  // What we send to a newly joined peer
  getSanitizedStateForNewPeer() {
    const mainHashes = new Set(this.chain.map((b) => b.hash));
    const orphans = [];
    this.allBlocks.forEach((block, hash) => {
      if (hash && !mainHashes.has(hash) && block && block.miner !== 'genesis') {
        orphans.push(block);
      }
    });
    const compact = (typeof this.compactChainForTransport === 'function')
      ? this.compactChainForTransport(70000)
      : { chain: this.chain, chainTruncated: false };
    const tip = this.chain.length ? this.chain[this.chain.length - 1] : null;
    return {
      chain: compact.chain,
      chainTruncated: !!compact.chainTruncated,
      chainHeight: compact.chainHeight != null
        ? compact.chainHeight
        : (tip && tip.index != null ? tip.index : Math.max(0, this.chain.length - 1)),
      tipHash: compact.tipHash || (tip && tip.hash),
      tipIndex: compact.tipIndex,
      genesis: compact.chainTruncated ? (this.chain[0] || null) : undefined,
      orphans: (compact.chainTruncated ? orphans.slice(-6) : orphans).slice(-12),
      participants: Array.from(this.participants.values()),
      adminSettings: { ...this.settings },
      networkStats: { ...this.networkStats },
      pendingTransactions: this.pendingTransactions.slice(0, 20),
      networkPaused: !!this.networkPaused,
      pendingFork: this.pendingFork ? { ...this.pendingFork } : null
    };
  }

  // Get current state snapshot (for persistence + admin UI)
  getFullState() {
    return {
      roomCode: this.roomCode,
      chain: this.chain,
      allBlocks: this._blocksForPersist(),
      participants: Array.from(this.participants.values()),
      knownNames: this.knownNames ? Array.from(this.knownNames.entries()) : [],
      settings: { ...this.settings },
      networkStats: { ...this.networkStats },
      pendingTransactions: [...this.pendingTransactions],
      networkPaused: !!this.networkPaused,
      pendingFork: this.pendingFork ? { ...this.pendingFork } : null,
      timestamp: Date.now()
    };
  }

  // Restore from persisted data (used on admin refresh)
  restoreFromPersisted(persisted) {
    if (!persisted) return false;

    if (persisted.chain && Array.isArray(persisted.chain) && persisted.chain.length > 0) {
      this.chain = persisted.chain;
      this.genesisCreated = true;
    }
    if (persisted.participants) {
      this.participants = new Map();
      persisted.participants.forEach(p => this.participants.set(p.userId, p));
    }
    if (!this.knownNames) this.knownNames = new Map();
    if (Array.isArray(persisted.knownNames)) {
      persisted.knownNames.forEach(function (pair) {
        if (pair && pair[0] && pair[1]) this.knownNames.set(String(pair[0]), String(pair[1]));
      }, this);
    } else if (persisted.knownNames && typeof persisted.knownNames === 'object') {
      Object.keys(persisted.knownNames).forEach((id) => {
        if (persisted.knownNames[id]) this.knownNames.set(String(id), String(persisted.knownNames[id]));
      });
    }
    this.participants.forEach((p, id) => {
      const n = String((p && (p.displayName || p.name)) || '').trim();
      if (n && !/^unnamed$/i.test(n)) this.knownNames.set(String(id), n);
    });
    if (persisted.settings) this.settings = { ...this.settings, ...persisted.settings };
    if (persisted.networkStats) this.networkStats = { ...this.networkStats, ...persisted.networkStats };
    if (persisted.pendingTransactions) this.pendingTransactions = persisted.pendingTransactions;
    if (typeof persisted.networkPaused === 'boolean') this.networkPaused = persisted.networkPaused;
    if (persisted.pendingFork) this.pendingFork = persisted.pendingFork;

    // Rebuild allBlocks: prefer persisted orphans + chain
    this.allBlocks = new Map();
    if (Array.isArray(persisted.allBlocks)) {
      persisted.allBlocks.forEach((b) => {
        if (b && b.hash) this.allBlocks.set(b.hash, b);
      });
    }
    this.chain.forEach((b) => {
      if (b && b.hash) this.allBlocks.set(b.hash, b);
    });

    // Re-run fork choice in case orphans are longer
    const priorChain = this.chain.slice();
    this.chain = this._selectBestChain();
    const restoredTip = this.chain[this.chain.length - 1];
    this.networkStats.blockHeight = (restoredTip && restoredTip.index != null)
      ? Number(restoredTip.index)
      : Math.max(0, this.chain.length - 1);
    this._recomputeMiningRewards();
    const priorTip = priorChain.length ? priorChain[priorChain.length - 1] : null;
    if (priorTip && restoredTip && priorTip.hash !== restoredTip.hash) {
      this._requeueOrphanedTransactions(priorChain, this.chain);
      this.purgeConfirmedFromMempool();
    }
    // Persist is a snapshot. A 10s-old (or pre-crash) _lastTipWallClock
    // must not look like a 27s freeze once this tab is live again.
    this._resetStallClocks();

    return true;
  }

  /** Classroom pause: freeze displayed network hashrate at 0. */
  zeroHashratesForPause() {
    this.participants.forEach((p) => {
      p.hashrate = 0;
      const r = String(p.role || '').toLowerCase();
      if (r !== 'admin' && r !== 'hub' && p.status === 'mining') p.status = 'idle';
    });
    if (this.networkStats) this.networkStats.totalHashrate = 0;
  }

  static formatDifficultyLabel(leading, secondary) {
    const L = Number(leading);
    const S = Number(secondary);
    const l = isNaN(L) ? 1 : L;
    const s = isNaN(S) ? 0 : Math.max(0, S);
    return l + ' leading zero' + (l === 1 ? '' : 's') + ' + 0x' + s.toString(16).toUpperCase();
  }

  // Update hashrate for a participant (called from client reports)
  updateHashrate(userId, hashrate) {
    const existing = this.participants.get(userId);
    if (existing) existing.lastSeenAt = Date.now();
    if (this.networkPaused) {
      this.zeroHashratesForPause();
      return;
    }
    const p = this.participants.get(userId);
    if (p) {
      p.hashrate = hashrate || 0;
      p.lastActivityAt = Date.now();
      const role = String(p.role || 'miner').toLowerCase();
      if (role === 'admin' || role === 'hub') {
        p.status = 'idle';
      } else if (role === 'wallet' || role === 'observer') {
        // Wallets stay idle unless a short-lived viz flash overrides
        if (p.status !== 'receiving' && p.status !== 'sending') p.status = 'idle';
      } else {
        p.status = (p.hashrate > 0) ? 'mining' : 'idle';
      }
      // Recalculate total
      let total = 0;
      this.participants.forEach(pp => total += (pp.hashrate || 0));
      this.networkStats.totalHashrate = total;
    }
  }

  setParticipantStatus(userId, status) {
    const p = this.participants.get(userId);
    if (p) {
      p.status = status || 'idle';
      p.lastActivityAt = Date.now();
    }
  }
}

window.RelayBlockchainState = RelayBlockchainState;
  } // end guard