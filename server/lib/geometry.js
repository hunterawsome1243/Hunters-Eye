// Small helpers to shrink GeoJSON before it goes to the browser.

function sqSegDist(p, a, b) {
  let [x, y] = a;
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) [x, y] = b;
    else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

// Douglas-Peucker line simplification.
export function simplifyLine(points, tolerance) {
  if (points.length <= 4) return points;
  const sqTol = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxD = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(points[i], points[first], points[last]);
      if (d > maxD) {
        maxD = d;
        index = i;
      }
    }
    if (maxD > sqTol) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out = points.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : points; // a ring needs at least 4 positions
}

const round = (n) => Math.round(n * 1e4) / 1e4;

// Returns a list of polygons (each a list of rings) from Polygon/MultiPolygon/GeometryCollection.
export function polygonsOf(geometry, tolerance = 0.005) {
  if (!geometry) return [];
  const ring = (r) => simplifyLine(r.map(([x, y]) => [round(x), round(y)]), tolerance);
  switch (geometry.type) {
    case 'Polygon':
      return [geometry.coordinates.map(ring)];
    case 'MultiPolygon':
      return geometry.coordinates.map((poly) => poly.map(ring));
    case 'GeometryCollection':
      return geometry.geometries.flatMap((g) => polygonsOf(g, tolerance));
    default:
      return [];
  }
}

