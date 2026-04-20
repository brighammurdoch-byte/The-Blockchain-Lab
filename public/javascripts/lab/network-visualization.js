/**
 * Network Topology Visualization
 * Real-time visualization of blockchain network nodes, connections, and block propagation
 */

class NetworkVisualization {
  constructor(svgSelector) {
    this.svg = document.querySelector(svgSelector);
    this.nodes = new Map(); // userId -> {id, x, y, status, lastUpdate}
    this.peers = []; // [{source, target}, ...]
    this.animatingBlocks = []; // [{blockHash, startNodeId, path, progress}, ...]
    this.width = this.svg.clientWidth || this.svg.getBoundingClientRect().width || 800;
    this.height = this.svg.clientHeight || this.svg.getBoundingClientRect().height || 600;
    
    // Create groups for layering
    this.createLayers();
    this.setupAnimation();
  }

  createLayers() {
    // Remove existing content
    this.svg.innerHTML = '';
    
    // Create D3-like groups for layering
    this.linkLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.linkLayer.setAttribute('class', 'links');
    this.svg.appendChild(this.linkLayer);
    
    this.nodeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.nodeLayer.setAttribute('class', 'nodes');
    this.svg.appendChild(this.nodeLayer);
    
    this.blockLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.blockLayer.setAttribute('class', 'blocks');
    this.svg.appendChild(this.blockLayer);
    
    // Add tooltip
    this.tooltipLayerer = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    this.tooltipLayer.setAttribute('id', 'tooltip');
    this.tooltipLayer.setAttribute('font-size', '12');
    this.tooltipLayer.setAttribute('fill', '#333');
    this.svg.appendChild(this.tooltipLayer);
  }

  setupAnimation() {
    // Request animation frame loop
    const animate = () => {
      this.updateBlockAnimations();
      requestAnimationFrame(animate);
    };
    animate();
  }

  /**
   * Initialize network with list of participants
   */
  initializeNetwork(participants, peerAssignments) {
    this.nodes.clear();
    this.peers = [];
    
    // Recalculate dimensions in case window resized or SVG was hidden on load
    this.width = this.svg.clientWidth || this.svg.getBoundingClientRect().width || 800;
    this.height = this.svg.clientHeight || this.svg.getBoundingClientRect().height || 600;
    
    const count = participants.length;
    const radius = Math.min(this.width, this.height) / 2 - 40;
    const centerX = this.width / 2;
    const centerY = this.height / 2;
    
    // Position nodes in a circle
    participants.forEach((userId, index) => {
      const angle = (index / count) * 2 * Math.PI;
      const x = centerX + radius * Math.cos(angle);
      const y = centerY + radius * Math.sin(angle);
      
      this.nodes.set(userId, {
        id: userId,
        x: x,
        y: y,
        status: 'mining', // mining, found, receiving, offline
        lastUpdate: Date.now()
      });
    });
    
    // Build peer connections from peerAssignments
    if (peerAssignments && peerAssignments.size > 0) {
      peerAssignments.forEach((peers, userId) => {
        peers.forEach(peerId => {
          // Only add connection if both nodes exist
          if (this.nodes.has(userId) && this.nodes.has(peerId)) {
            this.peers.push({ source: userId, target: peerId });
          }
        });
      });
    }
    
    this.render();
  }

  /**
   * Update peer list (for when network topology changes)
   */
  updatePeerAssignments(peerAssignments) {
    this.peers = [];
    
    if (peerAssignments && peerAssignments.size > 0) {
      peerAssignments.forEach((peers, userId) => {
        peers.forEach(peerId => {
          if (this.nodes.has(userId) && this.nodes.has(peerId)) {
            const existing = this.peers.find(p => p.source === userId && p.target === peerId);
            if (!existing) {
              this.peers.push({ source: userId, target: peerId });
            }
          }
        });
      });
    }
    
    this.render();
  }

  /**
   * Mark a node as having found a block
   */
  blockFound(minerId) {
    if (this.nodes.has(minerId)) {
      this.nodes.get(minerId).status = 'found';
      this.nodes.get(minerId).lastUpdate = Date.now();
      
      // Fade back to mining after 2 seconds
      setTimeout(() => {
        if (this.nodes.has(minerId)) {
          this.nodes.get(minerId).status = 'mining';
        }
      }, 2000);
      
      this.render();
    }
  }

  /**
   * Animate block propagation from source to all peers
   */
  broadcastBlock(blockHash, minerId, peerList) {
    if (!this.nodes.has(minerId)) return;
    
    // Create propagation path for each peer
    peerList.forEach(peerId => {
      if (this.nodes.has(peerId)) {
        this.animatingBlocks.push({
          blockHash: blockHash,
          startNodeId: minerId,
          targetNodeId: peerId,
          progress: 0, // 0 to 1
          startTime: Date.now(),
          duration: 800 // milliseconds
        });
      }
    });
  }

  /**
   * Update block animation positions
   */
  updateBlockAnimations() {
    const now = Date.now();
    const completed = [];
    
    this.animatingBlocks.forEach((block, index) => {
      block.progress = Math.min((now - block.startTime) / block.duration, 1);
      
      if (block.progress >= 1) {
        completed.push(index);
        // Flash the receiving node
        if (this.nodes.has(block.targetNodeId)) {
          const node = this.nodes.get(block.targetNodeId);
          if (node.status !== 'found') {
            node.status = 'receiving';
            setTimeout(() => {
              if (node.status === 'receiving') {
                node.status = 'mining';
              }
            }, 500);
          }
        }
      }
    });
    
    // Remove completed animations
    completed.reverse().forEach(index => {
      this.animatingBlocks.splice(index, 1);
    });
    
    if (this.animatingBlocks.length > 0) {
      this.render();
    }
  }

  /**
   * Mark a node as offline
   */
  setNodeOffline(userId) {
    if (this.nodes.has(userId)) {
      this.nodes.get(userId).status = 'offline';
      this.render();
    }
  }

  /**
   * Mark a node as online (mining)
   */
  setNodeOnline(userId) {
    if (this.nodes.has(userId)) {
      this.nodes.get(userId).status = 'mining';
      this.render();
    }
  }

  /**
   * Render the entire visualization
   */
  render() {
    // Clear layers
    this.linkLayer.innerHTML = '';
    this.nodeLayer.innerHTML = '';
    
    // Draw links
    this.peers.forEach(link => {
      if (this.nodes.has(link.source) && this.nodes.has(link.target)) {
        const sourceNode = this.nodes.get(link.source);
        const targetNode = this.nodes.get(link.target);
        
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', sourceNode.x);
        line.setAttribute('y1', sourceNode.y);
        line.setAttribute('x2', targetNode.x);
        line.setAttribute('y2', targetNode.y);
        line.setAttribute('stroke', '#999');
        line.setAttribute('stroke-width', '1');
        line.setAttribute('stroke-opacity', '0.4');
        
        this.linkLayer.appendChild(line);
      }
    });
    
    // Draw nodes
    this.nodes.forEach((node, userId) => {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', node.x);
      circle.setAttribute('cy', node.y);
      circle.setAttribute('r', '20');
      
      // Color based on status
      let color = '#4CAF50'; // mining (green)
      if (node.status === 'found') {
        color = '#FFC107'; // found (yellow)
      } else if (node.status === 'receiving') {
        color = '#2196F3'; // receiving (blue)
      } else if (node.status === 'offline') {
        color = '#f0f0f0'; // offline (white)
      }
      
      circle.setAttribute('fill', color);
      
      // Add border for offline
      if (node.status === 'offline') {
        circle.setAttribute('stroke', '#999');
        circle.setAttribute('stroke-width', '2');
      }
      
      circle.setAttribute('stroke-opacity', '0.6');
      circle.setAttribute('cursor', 'pointer');
      
      // Tooltip on hover
      circle.addEventListener('mouseenter', () => {
        this.showNodeTooltip(userId, node.x, node.y);
      });
      circle.addEventListener('mouseleave', () => {
        this.hideNodeTooltip();
      });
      
      this.nodeLayer.appendChild(circle);
      
      // Add node label
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', node.x);
      text.setAttribute('y', node.y);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dy', '0.3em');
      text.setAttribute('font-size', '11');
      text.setAttribute('fill', node.status === 'found' ? '#000' : '#fff');
      text.setAttribute('font-weight', 'bold');
      text.setAttribute('pointer-events', 'none');
      
      // Shorten user ID for display
      const displayId = userId.substring(0, 4) + '...';
      text.textContent = displayId;
      
      this.nodeLayer.appendChild(text);
    });
    
    // Draw animating blocks
    this.animatingBlocks.forEach(block => {
      if (this.nodes.has(block.startNodeId) && this.nodes.has(block.targetNodeId)) {
        const sourceNode = this.nodes.get(block.startNodeId);
        const targetNode = this.nodes.get(block.targetNodeId);
        
        // Interpolate position
        const x = sourceNode.x + (targetNode.x - sourceNode.x) * block.progress;
        const y = sourceNode.y + (targetNode.y - sourceNode.y) * block.progress;
        
        // Draw animated block as a small square
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', x - 5);
        rect.setAttribute('y', y - 5);
        rect.setAttribute('width', '10');
        rect.setAttribute('height', '10');
        rect.setAttribute('fill', '#FF6B6B');
        rect.setAttribute('opacity', String(1 - block.progress * 0.3)); // Fade as it arrives
        rect.setAttribute('rx', '2');
        
        this.blockLayer.appendChild(rect);
        
        // Add glow effect
        const glow = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        glow.setAttribute('x', x - 8);
        glow.setAttribute('y', y - 8);
        glow.setAttribute('width', '16');
        glow.setAttribute('height', '16');
        glow.setAttribute('fill', 'none');
        glow.setAttribute('stroke', '#FF6B6B');
        glow.setAttribute('stroke-width', '1');
        glow.setAttribute('opacity', String(0.5 * (1 - block.progress)));
        glow.setAttribute('rx', '2');
        
        this.blockLayer.appendChild(glow);
      }
    });
  }

  showNodeTooltip(userId, x, y) {
    const node = this.nodes.get(userId);
    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.setAttribute('id', 'nodeTooltip');
    txt.setAttribute('x', x);
    txt.setAttribute('y', y - 35);
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('font-size', '12');
    txt.setAttribute('fill', '#333');
    txt.setAttribute('background', '#fff');
    txt.setAttribute('font-weight', 'bold');
    
    const shortId = userId.substring(0, 8);
    txt.textContent = `${shortId} (${node.status})`;
    
    this.svg.appendChild(txt);
  }

  hideNodeTooltip() {
    const tooltip = document.getElementById('nodeTooltip');
    if (tooltip) tooltip.remove();
  }

  /**
   * Add entry to network stream log
   */
  addStreamEntry(message, type = 'info') {
    const now = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = `network-stream-entry text-${type === 'block' ? 'danger' : 'muted'}`;
    entry.style.fontSize = '11px';
    entry.style.padding = '5px';
    entry.style.borderBottom = '1px solid #eee';
    entry.innerHTML = `<strong>[${now}]</strong> ${message}`;
    
    const stream = document.getElementById('networkStream');
    stream.insertBefore(entry, stream.firstChild);
    
    // Keep only last 20 entries
    while (stream.children.length > 20) {
      stream.removeChild(stream.lastChild);
    }
  }
}
