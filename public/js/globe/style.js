// Builds the MapLibre style the globe runs on. Pure functions, no DOM: the
// smoke test and test/globe-style.test.js import this file under Node.
//
// The basemap is whatever style JSON the server points at (OpenFreeMap's dark
// style by default). buildStyle() returns a copy of it with the globe pieces
// added: the projection, sky and light, a satellite imagery layer under the
// roads and labels, and extruded buildings at street zooms.

// A true sphere until z9, flat Mercator from z11. Curvature is invisible by then
// and the dense city zooms run on the cheaper flat path. (The 'globe' preset is
// the same idea with the hand-over at z11-12.)
export const PROJECTION = { type: ['interpolate', ['linear'], ['zoom'], 9, 'vertical-perspective', 11, 'mercator'] };

// sky-color matches the page background (--bg) so space is seamless with the
// chrome; the atmosphere glow fades out between z4 and z7.
export const SKY = {
  'sky-color': '#0a0d12',
  'horizon-color': '#3b76b8',
  'sky-horizon-blend': 0.8,
  'fog-color': '#0a0d12',
  'fog-ground-blend': 0.5,
  'horizon-fog-blend': 0.8,
  'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.7, 4, 0.7, 7, 0],
};

// A low light from the top left of the screen: the atmosphere shows as a soft
// rim on the far limb instead of a bright half-globe that washes out the data.
export const LIGHT = { anchor: 'viewport', position: [1.5, 315, 45], intensity: 0.2 };

const SPHERE = '#0f141b'; // --panel: the bare globe where no imagery tile is drawn
const GIBS = 'Imagery: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS / ESDIS</a>';

// Free imagery that needs no key. All are Web Mercator tiles, 256 px.
export const IMAGERY = {
  // Sentinel-2 cloudless 2017 by EOX, 10 m, CC BY 4.0. Later years are CC BY-NC-SA.
  eox2017: {
    tiles: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2017_3857/default/g/{z}/{y}/{x}.jpg',
    minzoom: 1,
    maxzoom: 12,
    attribution: '<a href="https://cloudless.eox.at">EOxCloudless</a> by <a href="https://eox.at">EOX IT Services GmbH</a> (Contains modified Copernicus Sentinel data 2017) | <a href="https://maps.eox.at">EOX::Maps</a>',
  },
  eox2025: {
    tiles: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg',
    minzoom: 1,
    maxzoom: 12,
    attribution: '<a href="https://cloudless.eox.at">EOxCloudless</a> by <a href="https://eox.at">EOX IT Services GmbH</a> (Contains modified Copernicus Sentinel data 2025) | <a href="https://maps.eox.at">EOX::Maps</a>',
  },
  // NASA Blue Marble, public domain, 611 m/px: the automatic fallback.
  bluemarble: {
    tiles: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
    minzoom: 1,
    maxzoom: 7,
    attribution: GIBS,
  },
  night: {
    tiles: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_CityLights_2012/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg',
    minzoom: 1,
    maxzoom: 7,
    attribution: GIBS,
  },
};

export const IMAGERY_SOURCE = 'he-imagery';
export const IMAGERY_LAYER = 'he-imagery';
// NASA Blue Marble under the main imagery, so wherever a main tile is slow or
// never arrives the globe still shows the planet instead of a bare sphere.
export const IMAGERY_BASE = 'he-imagery-base';
export const BUILDINGS_LAYER = 'he-buildings-3d';

export function imagerySource(imagery) {
  return {
    type: 'raster',
    tiles: [imagery.tiles],
    tileSize: 256,
    minzoom: imagery.minzoom ?? 1,
    maxzoom: imagery.maxzoom ?? 12,
    attribution: imagery.attribution ?? '',
  };
}

// Full-strength imagery from space until z9.5, gone by z12, where the vector
// map's roads, water, parks and labels have taken over. The layer ends at z12
// whatever the source offers, so no invisible tile is ever requested.
export function imageryLayer(id = IMAGERY_LAYER) {
  return {
    id,
    type: 'raster',
    source: id,
    maxzoom: 12,
    paint: {
      'raster-opacity': ['interpolate', ['linear'], ['zoom'], 9.5, 1, 12, 0],
      'raster-fade-duration': 0,
      'raster-resampling': 'linear',
      'raster-brightness-max': 0.92,
      'raster-saturation': -0.1,
    },
  };
}

export function buildingsLayer() {
  return {
    id: BUILDINGS_LAYER,
    type: 'fill-extrusion',
    source: 'openmaptiles',
    'source-layer': 'building',
    minzoom: 14.5,
    paint: {
      'fill-extrusion-color': '#1b2431',
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': 0.85,
    },
  };
}

// Where the imagery goes: above the run of opaque fills a style starts with
// (background, water, land cover, parks...) and below its first line or symbol
// layer, so it covers the land but sits under roads, boundaries and labels.
// Falls back to "right after water", then to index 1.
export function imageryIndex(layers) {
  let i = 0;
  while (i < layers.length && (layers[i].type === 'background' || layers[i].type === 'fill')) i++;
  if (i > 0) return i;
  const water = layers.findIndex((l) => l.id === 'water');
  if (water >= 0) return water + 1;
  return Math.min(1, layers.length);
}

// Where the extruded buildings go: right after the style's own building
// footprints, so roads drawn before them stay under the roofs and the labels
// drawn after them stay readable. Falls back to after the last line layer.
export function buildingsIndex(layers) {
  const building = layers.findIndex((l) => l.id === 'building');
  if (building >= 0) return building + 1;
  let last = -1;
  layers.forEach((l, i) => {
    if (l.type === 'line' || l.type === 'fill') last = i;
  });
  return last + 1;
}

// A new style object: `base` is not modified.
export function buildStyle(base, { imagery } = {}) {
  const style = structuredClone(base);
  style.projection = structuredClone(PROJECTION);
  style.sky = structuredClone(SKY);
  style.light = structuredClone(LIGHT);
  style.sources = { ...(style.sources ?? {}) };
  style.layers = (style.layers ?? []).filter((l) => ![IMAGERY_LAYER, IMAGERY_BASE, BUILDINGS_LAYER].includes(l.id));
  delete style.sources[IMAGERY_SOURCE];
  delete style.sources[IMAGERY_BASE];

  const background = style.layers.find((l) => l.id === 'background' && l.type === 'background');
  if (background) background.paint = { ...(background.paint ?? {}), 'background-color': SPHERE };

  if (imagery?.tiles) {
    style.sources[IMAGERY_SOURCE] = imagerySource(imagery);
    const at = imageryIndex(style.layers);
    style.layers.splice(at, 0, imageryLayer());
    if (imagery.tiles !== IMAGERY.bluemarble.tiles) {
      style.sources[IMAGERY_BASE] = imagerySource(IMAGERY.bluemarble);
      style.layers.splice(at, 0, imageryLayer(IMAGERY_BASE));
    }
  }

  if (style.sources.openmaptiles && !style.layers.some((l) => l.type === 'fill-extrusion')) {
    style.layers.splice(buildingsIndex(style.layers), 0, buildingsLayer());
  }
  return style;
}

// The style the globe starts with, and the one it keeps when the basemap can't
// be fetched: a dark sphere with Natural Earth continents from a local file.
// No glyphs or sprite, so modules add no text layers on it. Imagery, when it
// loads, goes between the land fill and the coastlines.
export function fallbackStyle() {
  return {
    version: 8,
    projection: structuredClone(PROJECTION),
    sky: structuredClone(SKY),
    light: structuredClone(LIGHT),
    sources: { 'he-land': { type: 'geojson', data: '/data/land-110m.geojson' } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': SPHERE } },
      { id: 'he-land-fill', type: 'fill', source: 'he-land', paint: { 'fill-color': '#18222e' } },
      { id: 'he-land-line', type: 'line', source: 'he-land', paint: { 'line-color': '#2b3a4c', 'line-width': 0.8 } },
    ],
  };
}
