/**
 * Network Visualization for Blockchain Lab
 * D3.js-based real-time visualization of network topology and block propagation
 */

class NetworkVisualization {
  constructor(svgSelector) {
    this.svgSelector = svgSelector;
    this.svg = d3.select(svgSelector);
    
    // Use client dimensions or getBoundingClientRect to support responsive CSS widths
    const node = this.svg.node();
    this.width = node.clientWidth || node.getBoundingClientRect().width || 800;
    this.height = node.clientHeight || node.getBoundingClientRect().height || 600;
    
    this.nodes = [];
    this.links = [];
    this.nodeNames = new Map(); // Maps userId to display name
    this.nodeData = new Map(); // Maps userId to detailed node data {name, address, chainHeight, hashrate}
    this.blockInTransit = null;
    
    // Initialize D3 simulation with improved centering
    this.simulation = d3.forceSimulation()
      .force('link', d3.forceLink().id(d => d.id).distance(120))
      .force('charge', d3.forceManyBody().strength(-500))
      .force('center', d3.forceCenter(this.width / 2, this.height / 2))
      .force('collision', d3.forceCollide().radius(35));
    
    this.setupSVG();
    this.setupTooltip();
  }
  
  /**
   * Setup the tooltip element
   */
  setupTooltip() {
    // Create tooltip div if it doesn't exist
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
  
  /**
   * Store detailed node data for tooltip display
   */
  setNodeData(nodeId, data) {
    this.nodeData.set(nodeId, data);
  }
  
  /**
   * Show detailed node tooltip on hover
   */
  showNodeTooltip(event, nodeId) {
    const tooltip = document.getElementById('networkTooltip');
    const node = this.nodes.find(n => n.id === nodeId);
    const nodeInfo = this.nodeData.get(nodeId);
    
    if (!node) return;
    
    let tooltipHTML = `<strong style="color: #333; font-size: 13px;">${node.displayName || 'Unnamed Node'}</strong><br/>`;
    
    if (nodeInfo) {
      if (nodeInfo.address) {
        tooltipHTML += `<small><strong>Address:</strong> <code style="color: #666; font-size: 10px;">${nodeInfo.address.substring(0, 16)}...</code></small><br/>`;
      }
      if (nodeInfo.chainHeight !== undefined) {
        tooltipHTML += `<small><strong>Chain Height:</strong> ${nodeInfo.chainHeight}</small><br/>`;
      }
      if (nodeInfo.hashrate !== undefined) {
        tooltipHTML += `<small><strong>Hashrate:</strong> ${nodeInfo.hashrate.toFixed(1)} H/s</small><br/>`;
      }
      if (nodeInfo.forkChoice && nodeInfo.forkChoice !== 'classic') {
        tooltipHTML += `<small><strong>Fork:</strong> <span style="color: #9C27B0;">${nodeInfo.forkChoice.toUpperCase()}</span></small><br/>`;
      }
      if (nodeInfo.status) {
        tooltipHTML += `<small><strong>Status:</strong> <span style="color: ${this.getStatusColor(nodeInfo.status)};">${nodeInfo.status}</span></small>`;
      }
    } else {
      tooltipHTML += `<small style="color: #999;">ID: ${nodeId.substring(0, 12)}...</small>`;
    }
    
    tooltip.innerHTML = tooltipHTML;
    tooltip.style.display = 'block';
    
    // Position tooltip near cursor
    const x = event.pageX + 10;
    const y = event.pageY + 10;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }
  
  /**
   * Hide node tooltip
   */
  hideNodeTooltip() {
    const tooltip = document.getElementById('networkTooltip');
    if (tooltip) {
      tooltip.style.display = 'none';
    }
  }
  
  /**
   * Get color for status text
   */
  getStatusColor(status) {
    switch(status) {
      case 'mining': return '#4CAF50';
      case 'block-found': return '#FFC107';
      case 'receiving': return '#2196F3';
      case 'attacking': return '#F44336';
      default: return '#999';
    }
  }
  
  setupSVG() {
    // Clear previous content
    this.svg.selectAll('*').remove();
    
    // Add arrow markers for directed links
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
    
    // Create link layer (drawn first, so it appears behind)
    this.linkLayer = this.svg.append('g').attr('class', 'links');
    
    // Create node layer
    this.nodeLayer = this.svg.append('g').attr('class', 'nodes');
    
    // Create animation layer (for block propagation)
    this.animLayer = this.svg.append('g').attr('class', 'animations');
  }
  
  /**
   * Update the network topology
   * @param {Array} miners - Array of miner objects {id, status, chainHeight, name, address, hashrate}
   * @param {Map} peerAssignments - Map of userId -> [peer userIds]
   */
  updateTopology(miners, peerAssignments) {
    // Recalculate dimensions in case window resized or SVG was hidden on load
    const svgNode = this.svg.node();
    this.width = svgNode.clientWidth || svgNode.getBoundingClientRect().width || 800;
    this.height = svgNode.clientHeight || svgNode.getBoundingClientRect().height || 600;
    this.simulation.force('center', d3.forceCenter(this.width / 2, this.height / 2));
    
    const existingNodes = new Map(this.nodes.map(n => [n.id, n]));
    let nodesChanged = false;

    // Update existing nodes and find new ones
    miners.forEach(miner => {
      const existing = existingNodes.get(miner.userId);
      if (existing) {
        // Update properties but keep the object reference and its x/y
        existing.label = miner.name || miner.userId.substring(0, 8);
        existing.displayName = miner.name || '';
        existing.status = miner.status || 'idle';
        existing.chainHeight = miner.chainHeight || 0;
        existing.hashrate = miner.hashrate || 0;
        existing.forkChoice = miner.forkChoice || 'classic';
        existing.isColluding = miner.isColluding || false;
      } else {
        // This is a new node
        this.nodes.push({
          id: miner.userId,
          label: miner.name || miner.userId.substring(0, 8),
          displayName: miner.name || '',
          idShort: miner.userId.substring(0, 6),
          status: miner.status || 'idle',
          chainHeight: miner.chainHeight || 0,
          hashrate: miner.hashrate || 0,
          forkChoice: miner.forkChoice || 'classic',
          isColluding: miner.isColluding || false
        });
        nodesChanged = true;
      }
    });

    // Find and remove nodes that are no longer present
    const minerIds = new Set(miners.map(m => m.userId));
    const initialNodeCount = this.nodes.length;
    this.nodes = this.nodes.filter(n => minerIds.has(n.id));
    if (this.nodes.length !== initialNodeCount) {
      nodesChanged = true;
    }

    // Store detailed node data for tooltip
    miners.forEach(miner => {
      this.nodeData.set(miner.userId, {
        name: miner.name || 'Unnamed Node',
        address: miner.address || miner.userId,
        chainHeight: miner.chainHeight || 0,
        hashrate: miner.hashrate || 0,
        status: miner.status || 'idle',
        forkChoice: miner.forkChoice || 'classic',
        isColluding: miner.isColluding || false
      });
      if (miner.name) {
        this.nodeNames.set(miner.userId, miner.name);
      }
    });
    
    // Build links from peer assignments (only current peers)
    const newLinks = [];
    const linkSet = new Set();
    
    peerAssignments.forEach((peers, userId) => {
      if (peers && Array.isArray(peers)) {
        peers.forEach(peerId => {
          // Only add if peer node exists
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
    
    // Animate link changes (disappearing old, appearing new)
    this.animateLinkChanges(this.links, newLinks);
    
    this.links = newLinks;
    
    // Update simulation
    this.simulation.nodes(this.nodes);
    this.simulation.force('link').links(this.links);
    
    // Only restart simulation if the number of nodes changed to prevent twitching
    if (nodesChanged) {
      this.simulation.alpha(0.3).restart();
    }
    this.render();
  }
  
  /**
   * Animate peer connections appearing and disappearing
   */
  animateLinkChanges(oldLinks, newLinks) {
    const oldLinkKeys = new Set(oldLinks.map(l => `${l.source.id || l.source}-${l.target.id || l.target}`));
    const newLinkKeys = new Set(newLinks.map(l => `${l.source}-${l.target}`));
    
    // Find removed links
    oldLinks.forEach(link => {
      const key = `${link.source.id || link.source}-${link.target.id || link.target}`;
      if (!newLinkKeys.has(key)) {
        // Animate link removal
        d3.select(this.svgSelector)
          .selectAll('line')
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
    // Update links
    const links = this.linkLayer.selectAll('line').data(this.links, d => `${d.source.id || d.source}-${d.target.id || d.target}`);
    
    links.enter()
      .append('line')
      .attr('stroke', '#999')
      .attr('stroke-width', 1.5)
      .attr('opacity', 0.6)
      .merge(links)
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);
    
    links.exit().remove();
    
    // Update nodes
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
    
    // Add circle to node
    nodesEnter.append('circle')
      .attr('r', 22)
      .attr('class', 'node-circle')
      .style('cursor', 'pointer')
      .on('mouseenter', (event, d) => {
        this.showNodeTooltip(event, d.id);
        // Slightly enlarge on hover
        d3.select(event.target).transition().duration(200).attr('r', 26);
      })
      .on('mouseleave', (event, d) => {
        this.hideNodeTooltip();
        // Reset size
        d3.select(event.target).transition().duration(200).attr('r', 22);
      });
    
    // Add name label to node (positioned above)
    nodesEnter.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '-8px')
      .attr('font-size', '12px')
      .attr('font-weight', 'bold')
      .attr('fill', '#333')
      .attr('class', 'node-label-name')
      .attr('pointer-events', 'none');
    
    // Add ID label to node (positioned below)
    nodesEnter.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '8px')
      .attr('font-size', '10px')
      .attr('fill', '#666')
      .attr('class', 'node-label-id')
      .attr('pointer-events', 'none');
    
    // Update all nodes
    this.nodeLayer.selectAll('g.node')
      .attr('transform', d => `translate(${d.x},${d.y})`)
      .select('.node-circle')
      .attr('fill', d => this.getNodeColor(d.status))
      .attr('stroke', d => this.getNodeStroke(d.status))
      .attr('stroke-width', 2)
      .attr('opacity', 0.85);
    
    // Update name labels with better text
    this.nodeLayer.selectAll('g.node')
      .select('.node-label-name')
      .text(d => {
        const name = d.displayName || d.label;
        return name.length > 15 ? name.substring(0, 12) + '...' : name;
      });
    
    // Update ID labels
    this.nodeLayer.selectAll('g.node')
      .select('.node-label-id')
      .text(d => `#${d.idShort}`);
    
    // Update simulation tick
    this.simulation.on('tick', () => {
      links
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);
      
      nodes.merge(nodesEnter)
        .attr('transform', d => `translate(${d.x},${d.y})`);
    });
    
    nodes.exit().remove();
  }
  
  getNodeColor(status) {
    switch(status) {
      case 'mining': return '#4CAF50';
      case 'block-found': return '#FFC107';
      case 'receiving': return '#2196F3';
      case 'attacking': return '#F44336';
      default: return '#9E9E9E';
    }
  }
  
  getNodeStroke(status) {
    if (status === 'attacking') return '#FF5252';
    return '#333';
  }
  
  /**
   * Animate a block being mined
   * @param {string} minerId - ID of the miner who found the block
   */
  animateBlockMined(minerId) {
    const minerNode = this.nodes.find(n => n.id === minerId);
    if (!minerNode) return;
    
    // Highlight miner in yellow (block found)
    d3.select(this.svgSelector)
      .selectAll('g.node')
      .filter(d => d.id === minerId)
      .select('.node-circle')
      .transition()
      .duration(300)
      .attr('fill', '#FFC107')
      .on('end', () => {
        // Reset to mining color
        d3.select(this.svgSelector)
          .selectAll('g.node')
          .filter(d => d.id === minerId)
          .select('.node-circle')
          .transition()
          .duration(300)
          .attr('fill', '#4CAF50');
      });
  }
  
  /**
   * Animate block propagation from miner to peers
   * @param {string} minerId - ID of the original miner
   * @param {Array} recipientIds - IDs of nodes receiving the block
   * @param {Object} block - The block object
   */
  animateBlockPropagation(minerId, recipientIds, block) {
    const minerNode = this.nodes.find(n => n.id === minerId);
    if (!minerNode) return;
    
    // Animate block traveling to each peer
    recipientIds.forEach((recipientId, index) => {
      const recipientNode = this.nodes.find(n => n.id === recipientId);
      if (!recipientNode) return;
      
      // Stagger animations slightly
      setTimeout(() => {
        this.animateBlockTravel(minerNode, recipientNode, block);
      }, index * 150);
    });
  }
  
  /**
   * Animate a single block traveling between two nodes
   */
  animateBlockTravel(sourceNode, targetNode, block) {
    const animGroup = this.animLayer.append('g').attr('class', 'block-in-transit');
    
    // Create animated block circle
    const blockCircle = animGroup.append('circle')
      .attr('r', 8)
      .attr('fill', '#FFD700')
      .attr('opacity', 0.8)
      .attr('cx', sourceNode.x)
      .attr('cy', sourceNode.y);
    
    // Create label showing block hash (shortened)
    const blockLabel = animGroup.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '.3em')
      .attr('font-size', '9px')
      .attr('fill', '#333')
      .attr('cx', sourceNode.x)
      .attr('cy', sourceNode.y)
      .text(`#${block.index}`);
    
    // Animate movement from source to target
    blockCircle.transition()
      .duration(800)
      .attr('cx', targetNode.x)
      .attr('cy', targetNode.y)
      .on('end', () => {
        // Highlight receiving node
        d3.select(this.svgSelector)
          .selectAll('g.node')
          .filter(d => d.id === targetNode.id)
          .select('.node-circle')
          .transition()
          .duration(200)
          .attr('fill', '#2196F3')
          .on('end', () => {
            // Reset color
            d3.select(this.svgSelector)
              .selectAll('g.node')
              .filter(d => d.id === targetNode.id)
              .select('.node-circle')
              .transition()
              .duration(200)
              .attr('fill', '#4CAF50');
          });
        
        // Remove block animation
        animGroup.remove();
      });
    
    blockLabel.transition()
      .duration(800)
      .attr('x', targetNode.x)
      .attr('y', targetNode.y)
      .on('end', () => blockLabel.remove());
  }
  
  /**
   * Update a node's name
   * @param {string} nodeId - The node ID
   * @param {string} name - The new display name
   */
  setNodeName(nodeId, name) {
    const node = this.nodes.find(n => n.id === nodeId);
    if (node) {
      node.displayName = name;
      node.label = name;
      this.nodeNames.set(nodeId, name);
      
      // Update node data for tooltip
      const nodeInfo = this.nodeData.get(nodeId);
      if (nodeInfo) {
        nodeInfo.name = name;
      }
      
      // Update label immediately
      d3.select(this.svgSelector)
        .selectAll('g.node')
        .filter(d => d.id === nodeId)
        .select('.node-label-name')
        .text(name.length > 15 ? name.substring(0, 12) + '...' : name);
    }
  }
  
  /**
   * Set a node's status
   * @param {string} nodeId - The node ID
   * @param {string} status - Status: 'idle', 'mining', 'attacking', etc.
   */
  setNodeStatus(nodeId, status) {
    const node = this.nodes.find(n => n.id === nodeId);
    if (node) {
      node.status = status;
      
      // Update node data for tooltip
      const nodeInfo = this.nodeData.get(nodeId);
      if (nodeInfo) {
        nodeInfo.status = status;
      }
      
      // Update visual immediately
      d3.select(this.svgSelector)
        .selectAll('g.node')
        .filter(d => d.id === nodeId)
        .select('.node-circle')
        .attr('fill', this.getNodeColor(status));
    }
  }
  
  /**
   * Clear all animations
   */
  clearAnimations() {
    this.animLayer.selectAll('*').remove();
  }
}
