export function createTiles(width, height, tileSize) {
    const columns = Math.ceil(width / tileSize);
    const rows = Math.ceil(height / tileSize);
    const count = columns * rows;
    const tiles = [];
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
