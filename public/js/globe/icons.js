// Icons registered with the map. The plane is one white SDF image: MapLibre
// tints it per feature (altitude colour, selection) and can add a halo.

// Plane silhouette pointing north, centred on 0,0, about 14 px long.
export const PLANE_PATH = 'M0 -7 L1.3 -2.2 L7 1.2 L7 2.4 L1.2 0.9 L0.9 4.6 L2.6 6 L2.6 7 L0 6.2 L-2.6 7 L-2.6 6 L-0.9 4.6 L-1.2 0.9 L-7 2.4 L-7 1.2 L-1.3 -2.2 Z';
export const PLANE = typeof Path2D === 'undefined' ? null : new Path2D(PLANE_PATH);

// The plane drawn at 2x into a size x size canvas, returned as ImageData.
// Register it with ctx.addImage('he-plane', planeImage(), { sdf: true, pixelRatio: 2 }):
// icon-size 1 is then the 14 px plane the flat map drew.
export function planeImage(size = 32) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  g.setTransform(2, 0, 0, 2, size / 2, size / 2);
  g.fillStyle = '#ffffff';
  g.fill(PLANE);
  return g.getImageData(0, 0, size, size);
}
