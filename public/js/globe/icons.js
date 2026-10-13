// Icons registered with the map. The plane is one white signed distance field
// image: MapLibre tints it per feature (altitude colour, selection) and draws its
// icon halo as an even dark outline that keeps it readable over bright imagery.

// Plane silhouette pointing north, centred on 0,0, about 14 px long.
export const PLANE_PATH = 'M0 -7 L1.3 -2.2 L7 1.2 L7 2.4 L1.2 0.9 L0.9 4.6 L2.6 6 L2.6 7 L0 6.2 L-2.6 7 L-2.6 6 L-0.9 4.6 L-1.2 0.9 L-7 2.4 L-7 1.2 L-1.3 -2.2 Z';
export const PLANE = typeof Path2D === 'undefined' ? null : new Path2D(PLANE_PATH);

// The path's corners as [x, y] pairs (it is all straight lines).
const PLANE_POINTS = PLANE_PATH.match(/-?\d+(?:\.\d+)?/g).map(Number)
  .reduce((pts, v, i, all) => (i % 2 ? pts : [...pts, [v, all[i + 1]]]), []);

// Signed distance from (x, y) to the polygon's edge: positive inside, negative outside.
function signedDistance(points, x, y) {
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[j];
    const [bx, by] = points[i];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.min(Math.max(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0), 1);
    d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    if ((ay > y) !== (by > y) && x < ax + ((y - ay) * dx) / dy) inside = !inside;
  }
  return inside ? d : -d;
}

// The plane drawn at 2x into a size x size distance field, in MapLibre's SDF
// encoding (alpha 0.75 on the edge, one eighth less per texel outwards).
// Register it with ctx.addImage('he-plane', planeImage(), { sdf: true, pixelRatio: 2 }):
// icon-size 1 is then the 14 px plane the flat map drew, and icon-halo-width 2 a
// 1 px outline. The margin leaves room for that outline at the smallest icon size.
export function planeImage(size = 40) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const texels = 2 * signedDistance(PLANE_POINTS, (col + 0.5 - size / 2) / 2, (row + 0.5 - size / 2) / 2);
      const i = (row * size + col) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(255 * (0.75 + texels / 8));
    }
  }
  return { width: size, height: size, data };
}
