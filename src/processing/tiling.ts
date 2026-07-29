export interface Tile {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly index: number;
  readonly count: number;
}

export function createTiles(width: number, height: number, tileSize: number): Tile[] {
  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const count = columns * rows;
  const tiles: Tile[] = [];
  let index = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = column * tileSize;
      const y = row * tileSize;
      tiles.push({
        x,
        y,
        width: Math.min(tileSize, width - x),
        height: Math.min(tileSize, height - y),
        index,
        count
      });
      index += 1;
    }
  }
  return tiles;
}
