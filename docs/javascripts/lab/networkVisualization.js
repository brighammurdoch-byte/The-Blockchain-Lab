/**
 * Network Visualization for Blockchain Lab
 * D3.js-based real-time visualization of network topology,
 * node status colors, and packet travel (blocks + transactions).
 */

if (typeof window.NetworkVisualization === 'undefined') {
class NetworkVisualization {
  constructor(svgSelector) {
    this.svgSelector = svgSelector;
    this.svg = d3.select(svgSelector);

    const node = this.svg.node();
    this.width = node.clientWidth || node.getBoundingClientRect().width || 800;
    this.height = node.clientHeight || node.getBoundingClientRect().height || 600;

    this.nodes = [];
    this.links = [];
    this.nodeNames = new Map();
    this.nodeData = new Map();
    this.blockInTransit = null;
    this._statusTimers = new Map();
    this._lastTipMiner = null;
    this._lastTipHash = null;
    this.topologyMode = 'star'; // 'star' | 'mesh' — drives layout + packet paths

    this.simulation = d3.forceSimulation()
      .force('link', d3.forceLink().id(d => d.id).distance(120))
      .force('charge', d3.forceManyBody().strength(-500))
      .force('center', d3.forceCenter(this.width / 2, this.height / 2))
      .force('collision', d3.forceCollide().radius(48));

    this.setupSVG();
    this.setupTooltip();
    this._ensurePulseStyles();
  }

  _ensurePulseStyles() {
    if (document.getElementById('networkVizPulseStyles')) return;
    const style = document.createElement('style');
    style.id = 'networkVizPulseStyles';
    style.textContent = `
      @keyframes nv-mining-pulse {
        0% { opacity: 0.55; stroke-width: 2; }
        50% { opacity: 0.15; stroke-width: 8; }
        100% { opacity: 0.55; stroke-width: 2; }
      }
      @keyframes nv-found-flash {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.45; }
      }
      .nv-pulse-ring.mining {
        fill: none;
        stroke: #4CAF50;
        animation: nv-mining-pulse 1.4s ease-in-out infinite;
        pointer-events: none;
      }
      .nv-pulse-ring.block-found {
        fill: none;
        stroke: #FFC107;
        animation: nv-found-flash 0.45s ease-in-out 3;
        pointer-events: none;
      }
      .nv-pulse-ring.receiving {
        fill: none;
        stroke: #2196F3;
        animation: nv-found-flash 0.4s ease-in-out 2;
        pointer-events: none;
      }
      .nv-pulse-ring.attacking {
        fill: none;
        stroke: #F44336;
        animation: nv-mining-pulse 0.8s ease-in-out infinite;
        pointer-events: none;
      }
      .nv-link-active {
        stroke: #26A69A !important;
        stroke-width: 3 !important;
        opacity: 1 !important;
      }
      .nv-link-block {
        stroke: #FFC107 !important;
        stroke-width: 3 !important;
        opacity: 1 !important;
      }
    `;
    document.head.appendChild(style);
  }

  setupTooltip() {
    if (!document.getElementById('networkTooltip')) {
      const tooltip = document.createElement('div');
      tooltip.id = 'networkTooltip';
      tooltip.style.cssText = `
        position: fixed;
        background: white;
        padding: 12px;
        border-radius: 6px;
        border: 2px solid #333;
        box-shadow: 0 4px 10px rgba(0,0,0,0.3);
        z-index: 10000;
        display: none;
        font-size: 12px;
        max-width: 280px;
        pointer-events: none;
      `;
      document.body.appendChild(tooltip);
    }
  }

  setNodeData(nodeId, data) {
    this.nodeData.set(nodeId, data);
  }

  showNodeTooltip(event, nodeId) {
    const tooltip = document.getElementById('networkTooltip');
    const node = this.nodes.find(n => n.id === nodeId);
    const nodeInfo = this.nodeData.get(nodeId);

    if (!node) return;

    let tooltipHTML = `<strong style="color: #333; font-size: 13px;">${node.displayName || node.label || 'Unnamed Node'}</strong><br/>`;

    if (nodeInfo) {
      tooltipHTML += `<small><strong>Role:</strong> ${this._roleLabel(nodeInfo.role || node.role)}</small><br/>`;
      if (nodeInfo.address) {
        tooltipHTML += `<small><strong>Address:</strong> <code style="color: #666; font-size: 10px;">${nodeInfo.address.substring(0, 16)}...</code></small><br/>`;
      }
      if (nodeInfo.chainHeight !== undefined) {
        tooltipHTML += `<small><strong>Blocks mined:</strong> ${nodeInfo.chainHeight}</small><br/>`;
      }
      if (nodeInfo.hashrate !== undefined) {
        tooltipHTML += `<small><strong>Hashrate:</strong> ${Number(nodeInfo.hashrate).toFixed(1)} H/s</small><br/>`;
      }
      if (nodeInfo.forkChoice && nodeInfo.forkChoice !== 'classic') {
        tooltipHTML += `<small><strong>Fork:</strong> <span style="color: #9C27B0;">${nodeInfo.forkChoice.toUpperCase()}</span></small><br/>`;
      }
      const st = node.status || nodeInfo.status || 'idle';
      tooltipHTML += `<small><strong>Status:</strong> <span style="color: ${this.getStatusColor(st)}; font-weight:600;">${st}</span></small>`;
    } else {
      tooltipHTML += `<small style="color: #999;">ID: ${nodeId.substring(0, 12)}...</small>`;
    }

    tooltip.innerHTML = tooltipHTML;
    tooltip.style.display = 'block';
    tooltip.style.left = (event.pageX + 10) + 'px';
    tooltip.style.top = (event.pageY + 10) + 'px';
  }

  hideNodeTooltip() {
    const tooltip = document.getElementById('networkTooltip');
    if (tooltip) tooltip.style.display = 'none';
  }

  getStatusColor(status) {
    switch (status) {
      case 'mining': return '#4CAF50';
      case 'block-found': return '#FFC107';
      case 'receiving': return '#2196F3';
      case 'attacking': return '#F44336';
      case 'sending': return '#26A69A';
      default: return '#9E9E9E';
    }
  }

  setupSVG() {
    this.svg.selectAll('*').remove();

    this.svg.append('defs').append('marker')
      .attr('id', 'arrowhead')
      .attr('markerWidth', 10)
      .attr('markerHeight', 10)
      .attr('refX', 25)
      .attr('refY', 3)
      .attr('orient', 'auto')
      .append('polygon')
      .attr('points', '0 0, 10 3, 0 6')
      .attr('fill', '#999');

    this.linkLayer = this.svg.append('g').attr('class', 'links');
    this.nodeLayer = this.svg.append('g').attr('class', 'nodes');
    this.animLayer = this.svg.append('g').attr('class', 'animations');
  }

  /**
   * @param {Array} miners - {userId, status, chainHeight, name, address, hashrate, role}
   * @param {Map} peerAssignments - userId -> [peer userIds]
   * @param {Object} [opts] - { topologyMode: 'star'|'mesh', forceRelayout: boolean }
   */
  updateTopology(miners, peerAssignments, opts) {
    opts = opts || {};
    const svgNode = this.svg.node();
    let w = svgNode.clientWidth || svgNode.getBoundingClientRect().width || 0;
    let h = svgNode.clientHeight || svgNode.getBoundingClientRect().height || 0;
    if (!w || w < 40) {
      const parent = svgNode.parentElement;
      w = (parent && parent.clientWidth) || parseFloat(svgNode.getAttribute('width')) || 800;
    }
    if (!h || h < 40) {
      h = parseFloat(svgNode.getAttribute('height')) || 500;
    }
    this.width = w;
    this.height = h;
    this.simulation.force('center', d3.forceCenter(this.width / 2, this.height / 2));

    const prevMode = this.topologyMode;
    if (opts.topologyMode === 'mesh' || opts.topologyMode === 'star') {
      this.topologyMode = opts.topologyMode;
    }

    // Mesh needs slightly longer links / stronger repulsion so the graph opens up
    const isMesh = this.topologyMode === 'mesh';
    const linkForce = this.simulation.force('link');
    if (linkForce) {
      linkForce.distance(isMesh ? 150 : 120);
    }
    const chargeForce = this.simulation.force('charge');
    if (chargeForce) {
      chargeForce.strength(isMesh ? -650 : -500);
    }

    const existingNodes = new Map(this.nodes.map(n => [n.id, n]));
    let nodesChanged = false;

    miners.forEach(miner => {
      const role = this._normalizeRole(miner.role);
      const existing = existingNodes.get(miner.userId);
      const nextStatus = miner.status || 'idle';
      if (existing) {
        existing.label = miner.name || miner.userId.substring(0, 8);
        existing.displayName = miner.name || '';
        // Don't clobber short-lived flash statuses from live animations
        if (!this._statusTimers.has(miner.userId) ||
            (nextStatus !== 'idle' && nextStatus !== existing.status)) {
          if (!this._statusTimers.has(miner.userId)) {
            existing.status = nextStatus;
          }
        }
        existing.chainHeight = miner.chainHeight || 0;
        existing.hashrate = miner.hashrate || 0;
        existing.forkChoice = miner.forkChoice || 'classic';
        existing.isColluding = miner.isColluding || false;
        existing.role = role;
      } else {
        this.nodes.push({
          id: miner.userId,
          label: miner.name || miner.userId.substring(0, 8),
          displayName: miner.name || '',
          idShort: miner.userId.substring(0, 6),
          status: nextStatus,
          chainHeight: miner.chainHeight || 0,
          hashrate: miner.hashrate || 0,
          forkChoice: miner.forkChoice || 'classic',
          isColluding: miner.isColluding || false,
          role: role
        });
        nodesChanged = true;
      }
    });

    const minerIds = new Set(miners.map(m => m.userId));
    const initialNodeCount = this.nodes.length;
    this.nodes = this.nodes.filter(n => minerIds.has(n.id));
    if (this.nodes.length !== initialNodeCount) nodesChanged = true;

    miners.forEach(miner => {
      this.nodeData.set(miner.userId, {
        name: miner.name || 'Unnamed Node',
        address: miner.address || miner.userId,
        chainHeight: miner.chainHeight || 0,
        hashrate: miner.hashrate || 0,
        status: miner.status || 'idle',
        forkChoice: miner.forkChoice || 'classic',
        isColluding: miner.isColluding || false,
        role: this._normalizeRole(miner.role)
      });
      if (miner.name) this.nodeNames.set(miner.userId, miner.name);
    });

    const newLinks = [];
    const linkSet = new Set();

    peerAssignments.forEach((peers, userId) => {
      if (peers && Array.isArray(peers)) {
        peers.forEach(peerId => {
          if (this.nodes.find(n => n.id === peerId)) {
            const key = [userId, peerId].sort().join('->');
            if (!linkSet.has(key)) {
              linkSet.add(key);
              newLinks.push({
                source: userId,
                target: peerId,
                active: true
              });
            }
          }
        });
      }
    });

    const oldLinkKeys = new Set(
      (this.links || []).map(l => {
        const s = (l.source && l.source.id) || l.source;
        const t = (l.target && l.target.id) || l.target;
        return [s, t].sort().join('->');
      })
    );
    let linksChanged = oldLinkKeys.size !== linkSet.size;
    if (!linksChanged) {
      linkSet.forEach(k => {
        if (!oldLinkKeys.has(k)) linksChanged = true;
      });
    }
    const modeChanged = prevMode !== this.topologyMode;

    this.animateLinkChanges(this.links, newLinks);
    this.links = newLinks;

    this.simulation.nodes(this.nodes);
    this.simulation.force('link').links(this.links);

    // Restart forces when nodes, edges, or star↔mesh mode change so the layout reflows
    if (nodesChanged || linksChanged || modeChanged || opts.forceRelayout) {
      const alpha = (modeChanged || opts.forceRelayout) ? 0.9 : (linksChanged ? 0.55 : 0.3);
      this.simulation.alpha(alpha).restart();
    }
    this.render();
  }

  animateLinkChanges(oldLinks, newLinks) {
    const newLinkKeys = new Set(newLinks.map(l => `${l.source}-${l.target}`));

    oldLinks.forEach(link => {
      const key = `${link.source.id || link.source}-${link.target.id || link.target}`;
      if (!newLinkKeys.has(key)) {
        d3.select(this.svgSelector)
          .selectAll('line.nv-link')
          .filter(d => {
            const dKey = `${d.source.id || d.source}-${d.target.id || d.target}`;
            return dKey === key;
          })
          .transition()
          .duration(300)
          .attr('opacity', 0)
          .remove();
      }
    });
  }

  render() {
    const links = this.linkLayer.selectAll('line.nv-link')
      .data(this.links, d => `${d.source.id || d.source}-${d.target.id || d.target}`);

    links.enter()
      .append('line')
      .attr('class', 'nv-link')
      .attr('stroke', '#90A4AE')
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.55)
      .merge(links)
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    links.exit().remove();

    const nodes = this.nodeLayer.selectAll('g.node').data(this.nodes, d => d.id);

    const nodesEnter = nodes.enter()
      .append('g')
      .attr('class', 'node')
      .call(d3.drag()
        .on('start', (event, d) => {
          if (!event.active) this.simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) this.simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        })
      );

    nodesEnter.append('circle')
      .attr('class', 'nv-pulse-ring')
      .attr('r', 28)
      .attr('cx', 0)
      .attr('cy', 0)
      .attr('opacity', 0);

    nodesEnter.append('path')
      .attr('class', 'node-shape')
      .style('cursor', 'pointer')
      .on('mouseenter', (event, d) => {
        this.showNodeTooltip(event, d.id);
        d3.select(event.target).transition().duration(200).attr('transform', 'scale(1.12)');
      })
      .on('mouseleave', (event, d) => {
        this.hideNodeTooltip();
        d3.select(event.target).transition().duration(200).attr('transform', 'scale(1)');
      });

    nodesEnter.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '-28px')
      .attr('font-size', '12px')
      .attr('font-weight', 'bold')
      .attr('fill', '#1a1a1a')
      .attr('class', 'node-label-name')
      .attr('pointer-events', 'none');

    nodesEnter.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '34px')
      .attr('font-size', '10px')
      .attr('fill', '#555')
      .attr('class', 'node-label-id')
      .attr('pointer-events', 'none');

    const allNodes = nodes.merge(nodesEnter);

    allNodes.attr('transform', d => `translate(${d.x || 0},${d.y || 0})`);

    allNodes.select('.node-shape')
      .attr('d', d => this.getRoleShapePath(d.role))
      .transition()
      .duration(280)
      .attr('fill', d => this.getNodeColor(d.status))
      .attr('stroke', d => this.getNodeStroke(d.status))
      .attr('stroke-width', d => (d.status === 'mining' || d.status === 'attacking') ? 3 : 2)
      .attr('opacity', 0.95);

    allNodes.select('.nv-pulse-ring')
      .attr('class', d => {
        const st = d.status || 'idle';
        if (st === 'mining' || st === 'block-found' || st === 'receiving' || st === 'attacking') {
          return 'nv-pulse-ring ' + st;
        }
        return 'nv-pulse-ring';
      })
      .attr('opacity', d => {
        const st = d.status || 'idle';
        return (st === 'idle' || st === 'sending') ? 0 : null;
      });

    allNodes.select('.node-label-name')
      .text(d => {
        const name = (d.displayName || d.label || '').trim();
        if (!name) return 'Unnamed';
        return name.length > 16 ? name.substring(0, 14) + '…' : name;
      });

    allNodes.select('.node-label-id')
      .text(d => {
        const roleLabel = this._roleLabel(d.role);
        return roleLabel + ' · ' + (d.idShort || String(d.id || '').substring(0, 6));
      });

    this.simulation.on('tick', () => {
      this.linkLayer.selectAll('line.nv-link')
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);

      allNodes.attr('transform', d => `translate(${d.x},${d.y})`);
    });

    nodes.exit().remove();
  }

  _normalizeRole(role) {
    const r = String(role || 'miner').toLowerCase();
    if (r === 'admin' || r === 'hub') return 'admin';
    if (r === 'wallet' || r === 'observer' || r === 'observe') return 'wallet';
    return 'miner';
  }

  _roleLabel(role) {
    const r = this._normalizeRole(role);
    if (r === 'admin') return 'Admin';
    if (r === 'wallet') return 'Wallet';
    return 'Miner';
  }

  getRoleShapePath(role) {
    const r = this._normalizeRole(role);
    if (r === 'admin') {
      return 'M 0,-22 L 22,0 L 0,22 L -22,0 Z';
    }
    if (r === 'wallet') {
      return 'M -18,-18 H 18 V 18 H -18 Z';
    }
    const rad = 20;
    return 'M ' + rad + ',0 A ' + rad + ',' + rad + ' 0 1,0 ' + (-rad) + ',0 A ' + rad + ',' + rad + ' 0 1,0 ' + rad + ',0';
  }

  getNodeColor(status) {
    switch (status) {
      case 'mining': return '#4CAF50';
      case 'block-found': return '#FFC107';
      case 'receiving': return '#2196F3';
      case 'attacking': return '#F44336';
      case 'sending': return '#26A69A';
      default: return '#9E9E9E';
    }
  }

  getNodeStroke(status) {
    if (status === 'attacking') return '#FF5252';
    if (status === 'mining') return '#2E7D32';
    if (status === 'block-found') return '#F9A825';
    if (status === 'receiving') return '#1565C0';
    if (status === 'sending') return '#00897B';
    return '#546E7A';
  }

  _nodeSelection(nodeId) {
    return d3.select(this.svgSelector)
      .selectAll('g.node')
      .filter(d => d.id === nodeId);
  }

  _paintNode(nodeId, status) {
    const sel = this._nodeSelection(nodeId);
    sel.select('.node-shape')
      .transition()
      .duration(200)
      .attr('fill', this.getNodeColor(status))
      .attr('stroke', this.getNodeStroke(status))
      .attr('stroke-width', (status === 'mining' || status === 'attacking') ? 3 : 2);

    sel.select('.nv-pulse-ring')
      .attr('class', function () {
        if (status === 'mining' || status === 'block-found' || status === 'receiving' || status === 'attacking') {
          return 'nv-pulse-ring ' + status;
        }
        return 'nv-pulse-ring';
      })
      .attr('opacity', (status === 'idle' || status === 'sending') ? 0 : null);
  }

  /**
   * Temporary status flash that auto-reverts to a baseline.
   */
  flashNodeStatus(nodeId, status, ms, revertTo) {
    const node = this.nodes.find(n => n.id === nodeId);
    if (!node) return;
    if (this._statusTimers.has(nodeId)) {
      clearTimeout(this._statusTimers.get(nodeId));
    }
    const baseline = revertTo != null ? revertTo : (node._baselineStatus || node.status || 'idle');
    node._baselineStatus = baseline;
    node.status = status;
    const info = this.nodeData.get(nodeId);
    if (info) info.status = status;
    this._paintNode(nodeId, status);

    const t = setTimeout(() => {
      this._statusTimers.delete(nodeId);
      const n = this.nodes.find(x => x.id === nodeId);
      if (!n) return;
      const back = n._baselineStatus || 'idle';
      n.status = back;
      const ni = this.nodeData.get(nodeId);
      if (ni) ni.status = back;
      this._paintNode(nodeId, back);
    }, ms || 900);
    this._statusTimers.set(nodeId, t);
  }

  setNodeStatus(nodeId, status) {
    const node = this.nodes.find(n => n.id === nodeId);
    if (!node) return;
    // Don't overwrite an active flash with a weaker idle update mid-animation
    if (this._statusTimers.has(nodeId) && (status === 'idle' || status === 'mining')) {
      node._baselineStatus = status;
      return;
    }
    node.status = status;
    node._baselineStatus = status;
    const nodeInfo = this.nodeData.get(nodeId);
    if (nodeInfo) nodeInfo.status = status;
    this._paintNode(nodeId, status);
  }

  setNodeName(nodeId, name) {
    const node = this.nodes.find(n => n.id === nodeId);
    if (node) {
      node.displayName = name;
      node.label = name;
      this.nodeNames.set(nodeId, name);
      const nodeInfo = this.nodeData.get(nodeId);
      if (nodeInfo) nodeInfo.name = name;
      this._nodeSelection(nodeId)
        .select('.node-label-name')
        .text(name.length > 15 ? name.substring(0, 12) + '...' : name);
    }
  }

  _findHubId() {
    const admin = this.nodes.find(n => this._normalizeRole(n.role) === 'admin');
    return admin ? admin.id : (this.nodes[0] && this.nodes[0].id);
  }

  _linkKey(a, b) {
    return [a, b].sort().join('-');
  }

  _highlightLink(sourceId, targetId, klass, ms) {
    const key1 = `${sourceId}-${targetId}`;
    const key2 = `${targetId}-${sourceId}`;
    const lines = this.linkLayer.selectAll('line.nv-link')
      .filter(d => {
        const s = d.source.id || d.source;
        const t = d.target.id || d.target;
        return (`${s}-${t}` === key1 || `${s}-${t}` === key2);
      });
    lines.classed(klass || 'nv-link-active', true);
    setTimeout(() => {
      lines.classed('nv-link-active', false).classed('nv-link-block', false);
    }, ms || 900);
  }

  /** Alias used by admin projector */
  blockFound(minerId) {
    this.animateBlockMined(minerId);
  }

  animateBlockMined(minerId) {
    const minerNode = this.nodes.find(n => n.id === minerId);
    if (!minerNode) return;
    const revert = minerNode.hashrate > 0 ? 'mining' : (minerNode._baselineStatus || 'idle');
    this.flashNodeStatus(minerId, 'block-found', 1200, revert);
  }

  animateBlockPropagation(minerId, recipientIds, block) {
    const minerNode = this.nodes.find(n => n.id === minerId);
    if (!minerNode) return;
    const ids = (recipientIds || []).filter(id => id && id !== minerId);
    ids.forEach((recipientId, index) => {
      const recipientNode = this.nodes.find(n => n.id === recipientId);
      if (!recipientNode) return;
      setTimeout(() => {
        this.animatePacketTravel(minerNode, recipientNode, {
          kind: 'block',
          label: block && block.index != null ? '#' + block.index : 'blk',
          color: '#FFC107',
          linkClass: 'nv-link-block'
        });
      }, index * 120);
    });
  }

  /**
   * Fan-out transaction packets.
   * Star (admin-hosted): sender → hub → everyone else.
   * Mesh (full P2P): sender → every other peer directly.
   */
  animateTransactionPropagation(fromId, tx) {
    const fromNode = this.nodes.find(n => n.id === fromId);
    if (!fromNode) return;

    const amount = tx && tx.amount != null ? tx.amount : '';
    const label = amount !== '' ? String(amount) : 'tx';
    const others = this.nodes.map(n => n.id).filter(id => id !== fromId);

    this.flashNodeStatus(fromId, 'sending', 700, fromNode._baselineStatus || fromNode.status || 'idle');

    const runLeg = (srcId, dstId, delay) => {
      const src = this.nodes.find(n => n.id === srcId);
      const dst = this.nodes.find(n => n.id === dstId);
      if (!src || !dst) return;
      setTimeout(() => {
        this.animatePacketTravel(src, dst, {
          kind: 'tx',
          label: label,
          color: '#26A69A',
          linkClass: 'nv-link-active'
        });
      }, delay);
    };

    if (this.topologyMode === 'mesh') {
      others.forEach((id, i) => runLeg(fromId, id, i * 90));
      return;
    }

    const hubId = this._findHubId();
    if (hubId && fromId !== hubId) {
      runLeg(fromId, hubId, 0);
      let i = 0;
      others.forEach(id => {
        if (id === hubId) return;
        runLeg(hubId, id, 650 + i * 110);
        i += 1;
      });
    } else {
      others.forEach((id, i) => runLeg(fromId, id, i * 110));
    }
  }

  animatePacketTravel(sourceNode, targetNode, opts) {
    opts = opts || {};
    const color = opts.color || '#FFD700';
    const label = opts.label != null ? String(opts.label) : '';
    const duration = opts.duration || 750;
    const kind = opts.kind || 'block';

    this._highlightLink(sourceNode.id, targetNode.id, opts.linkClass || 'nv-link-active', duration + 100);

    const animGroup = this.animLayer.append('g').attr('class', 'packet-in-transit');

    let packet;
    if (kind === 'tx') {
      // Diamond packet for transactions
      packet = animGroup.append('path')
        .attr('d', 'M 0,-7 L 7,0 L 0,7 L -7,0 Z')
        .attr('fill', color)
        .attr('stroke', '#004D40')
        .attr('stroke-width', 1)
        .attr('opacity', 0.95)
        .attr('transform', `translate(${sourceNode.x},${sourceNode.y})`);
    } else {
      packet = animGroup.append('circle')
        .attr('r', 8)
        .attr('fill', color)
        .attr('stroke', '#F57F17')
        .attr('stroke-width', 1.5)
        .attr('opacity', 0.9)
        .attr('cx', sourceNode.x)
        .attr('cy', sourceNode.y);
    }

    const packetLabel = animGroup.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', kind === 'tx' ? -12 : 3)
      .attr('font-size', '9px')
      .attr('font-weight', 'bold')
      .attr('fill', kind === 'tx' ? '#00695C' : '#333')
      .attr('x', sourceNode.x)
      .attr('y', sourceNode.y)
      .text(label);

    const sx = sourceNode.x;
    const sy = sourceNode.y;
    const tx = targetNode.x;
    const ty = targetNode.y;

    if (kind === 'tx') {
      packet.transition()
        .duration(duration)
        .ease(d3.easeCubicInOut)
        .attrTween('transform', () => {
          return (t) => {
            const x = sx + (tx - sx) * t;
            const y = sy + (ty - sy) * t;
            return `translate(${x},${y})`;
          };
        })
        .on('end', () => {
          this.flashNodeStatus(
            targetNode.id,
            'receiving',
            700,
            targetNode.hashrate > 0 ? 'mining' : (targetNode._baselineStatus || targetNode.status || 'idle')
          );
          animGroup.remove();
        });
    } else {
      packet.transition()
        .duration(duration)
        .ease(d3.easeCubicInOut)
        .attr('cx', tx)
        .attr('cy', ty)
        .on('end', () => {
          this.flashNodeStatus(
            targetNode.id,
            'receiving',
            700,
            targetNode.hashrate > 0 ? 'mining' : (targetNode._baselineStatus || targetNode.status || 'idle')
          );
          animGroup.remove();
        });
    }

    packetLabel.transition()
      .duration(duration)
      .ease(d3.easeCubicInOut)
      .attr('x', tx)
      .attr('y', ty);
  }

  /** Backward-compatible name */
  animateBlockTravel(sourceNode, targetNode, block) {
    this.animatePacketTravel(sourceNode, targetNode, {
      kind: 'block',
      label: block && block.index != null ? '#' + block.index : 'blk',
      color: '#FFC107',
      linkClass: 'nv-link-block'
    });
  }

  clearAnimations() {
    this.animLayer.selectAll('*').remove();
  }
}

window.NetworkVisualization = NetworkVisualization;
} // end guard
