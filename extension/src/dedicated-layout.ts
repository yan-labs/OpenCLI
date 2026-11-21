type Rect = { left: number; top: number; width: number; height: number };
const DEDICATED_PREFERRED_TILE = { width: 1280, height: 900 };
const DEDICATED_MIN_TILE = { width: 900, height: 620 };
const DEDICATED_MAX_TILE = { width: 1600, height: 1100 };
const DEDICATED_CELL = { offsetX: 80, offsetY: 60 };

/** Resolution alone determines the grid. */
function dedicatedGrid(area: Rect): { cols: number; rows: number; width: number; height: number } {
  const divisions = (length: number, preferred: number, min: number, max: number): number => {
    const upper = Math.max(1, Math.floor(length / min));
    const lower = Math.max(1, Math.ceil(length / max));
    // Some resolutions cannot satisfy both bounds with equal tiles (e.g. 1700px).
    // Keep the minimum and full coverage in that case; the maximum is a preference.
    return Math.min(upper, Math.max(lower, Math.round(length / preferred)));
  };
  const cols = divisions(area.width, DEDICATED_PREFERRED_TILE.width, DEDICATED_MIN_TILE.width, DEDICATED_MAX_TILE.width);
  const rows = divisions(area.height, DEDICATED_PREFERRED_TILE.height, DEDICATED_MIN_TILE.height, DEDICATED_MAX_TILE.height);
  return { cols, rows, width: Math.floor(area.width / cols), height: Math.floor(area.height / rows) };
}

/** Fixed row-major tiles; only overflow cascades. Remainder pixels go to edge cells. */
function dedicatedTile(area: Rect, index: number): Rect {
  const grid = dedicatedGrid(area);
  const capacity = grid.cols * grid.rows;
  if (index >= capacity) {
    const step = index - capacity + 1;
    return {
      left: area.left + (step * DEDICATED_CELL.offsetX) % (area.width - grid.width + 1),
      top: area.top + (step * DEDICATED_CELL.offsetY) % (area.height - grid.height + 1),
      width: grid.width,
      height: grid.height,
    };
  }
  const i = ((Math.trunc(index) % capacity) + capacity) % capacity;
  const col = i % grid.cols;
  const row = Math.floor(i / grid.cols);
  return {
    left: area.left + col * grid.width,
    top: area.top + row * grid.height,
    width: col === grid.cols - 1 ? area.width - col * grid.width : grid.width,
    height: row === grid.rows - 1 ? area.height - row * grid.height : grid.height,
  };
}

export async function dedicatedBounds(occupied: readonly Rect[]): Promise<Rect | undefined> {
  if (!chrome.system?.display) return undefined;
  const displays = (await chrome.system.display.getInfo())
    .filter(display => display.workArea.width > 0 && display.workArea.height > 0)
    .sort((a, b) => Number(a.isPrimary) - Number(b.isPrimary));
  for (const display of displays) {
    const area = display.workArea;
    const grid = dedicatedGrid(area);
    for (let index = 0; index < grid.cols * grid.rows; index++) {
      const tile = dedicatedTile(area, index);
      if (!occupied.some(window => window.left === tile.left && window.top === tile.top)) return tile;
    }
  }
  const area = displays[0]?.workArea;
  return area && dedicatedTile(area, occupied.length);
}
