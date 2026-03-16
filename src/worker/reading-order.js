/**
 * 読み順処理モジュール（XY-Cut アルゴリズム）
 * 参照実装: ndlocr-lite/src/reading_order/xy_cut/block_xy_cut.py
 */

function makeNode(x0, y0, x1, y1) {
  return { x0, y0, x1, y1, children: [], lineIndices: [], numLines: 0, numVerticalLines: 0, isXSplit: false };
}

export class ReadingOrderProcessor {
  constructor() {
    this.GRID = 100;
  }

  process(textBlocks, blocks, options = {}) {
    if (!textBlocks || textBlocks.length === 0) return [];
    const { minConfidence = 0.1 } = options;

    const validBlocks = textBlocks.filter(
      b => b.confidence >= minConfidence && b.text && b.text.trim().length > 0
    );
    if (validBlocks.length === 0) return [];
    if (validBlocks.length === 1) {
      return [{ ...validBlocks[0], readingOrder: 1 }];
    }

    if (blocks && blocks.length > 0) {
      return this._processWithBlocks(validBlocks, blocks);
    }
    return this._processXYCut(validBlocks);
  }

  _processWithBlocks(lines, blocks) {
    const assigned = new Map();
    const unassigned = [];
    for (const line of lines) {
      const cx = line.x + line.width / 2;
      const cy = line.y + line.height / 2;
      const blockIdx = blocks.findIndex(
        b => cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height
      );
      if (blockIdx >= 0) {
        if (!assigned.has(blockIdx)) assigned.set(blockIdx, []);
        assigned.get(blockIdx).push(line);
      } else {
        unassigned.push(line);
      }
    }

    const allAssigned = [...assigned.values()].flat();
    if (allAssigned.length < lines.length * 0.7) {
      return this._processXYCut(lines);
    }

    const groups = [];

    for (const groupLines of assigned.values()) {
      const x0 = Math.min(...groupLines.map(l => l.x));
      const y0 = Math.min(...groupLines.map(l => l.y));
      const x1 = Math.max(...groupLines.map(l => l.x + l.width));
      const y1 = Math.max(...groupLines.map(l => l.y + l.height));
      groups.push({ lines: groupLines, bbox: [x0, y0, x1, y1] });
    }
    for (const line of unassigned) {
      groups.push({ lines: [line], bbox: [line.x, line.y, line.x + line.width, line.y + line.height] });
    }

    const groupRanks = this._getXYCutRanks(groups.map(g => g.bbox));

    const sortedGroups = groups
      .map((g, i) => ({ ...g, rank: groupRanks[i] }))
      .sort((a, b) => a.rank - b.rank);

    const result = [];
    for (const group of sortedGroups) {
      result.push(...(group.lines.length > 1 ? this._processXYCut(group.lines) : group.lines));
    }

    return result.map((b, i) => ({ ...b, readingOrder: i + 1 }));
  }

  _processXYCut(validBlocks) {
    const rawBboxes = validBlocks.map(b => [b.x, b.y, b.x + b.width, b.y + b.height]);
    const ranks = this._getXYCutRanks(rawBboxes);
    const result = validBlocks.map((block, i) => ({ ...block, readingOrder: ranks[i] + 1 }));
    result.sort((a, b) => a.readingOrder - b.readingOrder);
    return result;
  }

  _getXYCutRanks(rawBboxes) {
    if (rawBboxes.length === 0) return [];
    if (rawBboxes.length === 1) return [0];
    const { normBboxes, w, h } = this._normalizeBboxes(rawBboxes);
    const table = this._makeMeshTable(normBboxes, w, h);
    const root = makeNode(0, 0, w, h);
    this._xyCut(table, root);
    this._assignBboxToNode(root, normBboxes);
    this._sortNodes(root, normBboxes);
    const ranks = new Array(rawBboxes.length).fill(-1);
    this._getRanking(root, ranks, 0);
    return ranks;
  }

  _normalizeBboxes(bboxes) {
    const xMin = Math.min(...bboxes.map(b => b[0]));
    const yMin = Math.min(...bboxes.map(b => b[1]));
    const xMax = Math.max(...bboxes.map(b => b[2]));
    const yMax = Math.max(...bboxes.map(b => b[3]));
    const wPage = xMax - xMin;
    const hPage = yMax - yMin;
    if (wPage === 0 || hPage === 0) {
      const norm = bboxes.map(() => [0, 0, 1, 1]);
      return { normBboxes: norm, w: 2, h: 2 };
    }

    const isPortrait = hPage >= wPage;
    const xGrid = isPortrait ? this.GRID * (wPage / hPage) : this.GRID;
    const yGrid = isPortrait ? this.GRID : this.GRID * (hPage / wPage);
    const w = Math.ceil(xGrid) + 1;
    const h = Math.ceil(yGrid) + 1;

    const normBboxes = bboxes.map(b => {
      const nx0 = Math.max(0, Math.floor((b[0] - xMin) * xGrid / wPage));
      const ny0 = Math.max(0, Math.floor((b[1] - yMin) * yGrid / hPage));
      const nx1 = Math.min(w - 1, Math.ceil((b[2] - xMin) * xGrid / wPage));
      const ny1 = Math.min(h - 1, Math.ceil((b[3] - yMin) * yGrid / hPage));
      return [nx0, ny0, Math.max(nx0 + 1, nx1), Math.max(ny0 + 1, ny1)];
    });
    return { normBboxes, w, h };
  }

  _makeMeshTable(bboxes, w, h) {
    const table = Array.from({ length: h }, () => new Array(w).fill(0));
    for (const [x0, y0, x1, y1] of bboxes) {
      for (let y = y0; y < Math.min(y1, h); y++) {
        for (let x = x0; x < Math.min(x1, w); x++) {
          table[y][x] = 1;
        }
      }
    }
    return table;
  }

  _calcHist(table, x0, y0, x1, y1) {
    const xHist = new Array(x1 - x0).fill(0);
    const yHist = new Array(y1 - y0).fill(0);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const v = table[y][x];
        xHist[x - x0] += v;
        yHist[y - y0] += v;
      }
    }
    return { xHist, yHist };
  }

  _calcMinSpan(hist) {
    if (hist.length <= 1) return [0, hist.length, 0];
    const minVal = Math.min(...hist);
    const maxVal = Math.max(...hist);
    let bestStart = 0, bestEnd = 0, bestLen = 0;
    let gapStart = -1;
    for (let i = 0; i <= hist.length; i++) {
      if (i < hist.length && hist[i] === minVal) {
        if (gapStart === -1) gapStart = i;
      } else {
        if (gapStart !== -1) {
          const len = i - gapStart;
          if (len > bestLen) { bestLen = len; bestStart = gapStart; bestEnd = i; }
          gapStart = -1;
        }
      }
    }
    const score = maxVal > 0 ? -minVal / maxVal : 0;
    return [bestStart, bestEnd, score];
  }

  _xyCut(table, node) {
    const { x0, y0, x1, y1 } = node;
    if (x0 >= x1 || y0 >= y1) return;

    const { xHist, yHist } = this._calcHist(table, x0, y0, x1, y1);
    let [xBeg, xEnd, xVal] = this._calcMinSpan(xHist);
    let [yBeg, yEnd, yVal] = this._calcMinSpan(yHist);
    xBeg += x0; xEnd += x0;
    yBeg += y0; yEnd += y0;

    if (x0 === xBeg && x1 === xEnd && y0 === yBeg && y1 === yEnd) return;

    if (yVal < xVal) {
      this._splitX(table, node, xBeg, xEnd);
    } else if (xVal < yVal) {
      this._splitY(table, node, yBeg, yEnd);
    } else if ((xEnd - xBeg) < (yEnd - yBeg)) {
      this._splitY(table, node, yBeg, yEnd);
    } else {
      this._splitX(table, node, xBeg, xEnd);
    }
  }

  _splitX(table, parent, gapX0, gapX1) {
    parent.isXSplit = true;
    const { x0, y0, x1, y1 } = parent;
    this._addChildAndCut(table, parent, x0, y0, gapX0, y1);
    this._addChildAndCut(table, parent, gapX0, y0, gapX1, y1);
    this._addChildAndCut(table, parent, gapX1, y0, x1, y1);
  }

  _splitY(table, parent, gapY0, gapY1) {
    parent.isXSplit = false;
    const { x0, y0, x1, y1 } = parent;
    this._addChildAndCut(table, parent, x0, y0, x1, gapY0);
    this._addChildAndCut(table, parent, x0, gapY0, x1, gapY1);
    this._addChildAndCut(table, parent, x0, gapY1, x1, y1);
  }

  _addChildAndCut(table, parent, x0, y0, x1, y1) {
    if (x0 >= x1 || y0 >= y1) return;
    if (x0 === parent.x0 && y0 === parent.y0 && x1 === parent.x1 && y1 === parent.y1) return;
    const child = makeNode(x0, y0, x1, y1);
    parent.children.push(child);
    this._xyCut(table, child);
  }

  _assignBboxToNode(root, bboxes) {
    const leaves = this._collectLeaves(root);
    const leafBboxes = leaves.map(l => [l.x0, l.y0, l.x1, l.y1]);

    for (let i = 0; i < bboxes.length; i++) {
      const ious = this._calcIous(bboxes[i], leafBboxes);
      let bestJ = 0, bestIou = -1;
      for (let j = 0; j < ious.length; j++) {
        if (ious[j] > bestIou) { bestIou = ious[j]; bestJ = j; }
      }
      leaves[bestJ].lineIndices.push(i);
    }
  }

  _collectLeaves(node) {
    if (node.children.length === 0) return [node];
    return node.children.flatMap(c => this._collectLeaves(c));
  }

  _calcIous(box, boxes) {
    return boxes.map(b => {
      const ix0 = Math.max(box[0], b[0]);
      const iy0 = Math.max(box[1], b[1]);
      const ix1 = Math.min(box[2], b[2]);
      const iy1 = Math.min(box[3], b[3]);
      const inter = Math.max(0, ix1 - ix0) * Math.max(0, iy1 - iy0);
      if (inter === 0) return 0;
      const areaA = (box[2] - box[0]) * (box[3] - box[1]);
      const areaB = (b[2] - b[0]) * (b[3] - b[1]);
      return inter / (areaA + areaB - inter);
    });
  }

  _sortNodes(node, bboxes) {
    if (node.lineIndices.length > 0) {
      const indices = node.lineIndices;
      node.numLines = indices.length;
      node.numVerticalLines = indices.filter(i => {
        const b = bboxes[i];
        return (b[2] - b[0]) < (b[3] - b[1]);
      }).length;

      if (indices.length > 1) {
        const isVert = this._isVertical(node);
        indices.sort((a, b) => {
          const ba = bboxes[a], bb = bboxes[b];
          if (isVert) return ba[0] !== bb[0] ? bb[0] - ba[0] : ba[1] - bb[1];
          return ba[1] !== bb[1] ? ba[1] - bb[1] : ba[0] - bb[0];
        });
      }
    } else {
      for (const child of node.children) {
        const [n, v] = this._sortNodes(child, bboxes);
        node.numLines += n;
        node.numVerticalLines += v;
      }
      if (node.isXSplit && this._isVertical(node)) {
        node.children.reverse();
      }
    }
    return [node.numLines, node.numVerticalLines];
  }

  _isVertical(node) {
    return node.numLines < node.numVerticalLines * 2;
  }

  _getRanking(node, ranks, rank) {
    for (const i of node.lineIndices) {
      ranks[i] = rank++;
    }
    for (const child of node.children) {
      rank = this._getRanking(child, ranks, rank);
    }
    return rank;
  }
}
