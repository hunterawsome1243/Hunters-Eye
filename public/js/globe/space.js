// The space behind the globe: a custom layer drawn first, under the sphere, that
// paints a faint sparse starfield and a soft vignette (a touch lighter behind the
// planet, the page background at the edges, so the chrome stays seamless).
// MapLibre clears the canvas with the flat sky colour before the layers run, so
// this is the only way to give the sky any depth without a second canvas.
//
// Everything is in screen space and static: the stars never move with the globe,
// like a backdrop, so a spinning or dragged planet reads as the thing that moves.
// One fullscreen triangle, one hash per pixel: cheaper than a tile.

const VERT = `#version 300 es
const vec2 pts[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
// At the far plane: the sphere and the basemap's opaque fills are drawn before this
// layer with depth written, so the backdrop only lands where nothing else has.
void main() { gl_Position = vec4(pts[gl_VertexID], 1.0, 1.0); }`;

const FRAG = `#version 300 es
precision mediump float;
uniform vec2 u_size;   // canvas size in device pixels
uniform float u_px;    // device pixels per CSS pixel
uniform float u_stars; // 0 hides the stars (reduced transparency / low power)
out vec4 color;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  // Vignette: --bg at the edges, a little lighter and bluer towards the middle,
  // centred slightly below the midpoint where the globe usually sits.
  float d = distance(uv * vec2(u_size.x / u_size.y, 1.0), vec2(0.5 * u_size.x / u_size.y, 0.45));
  vec3 edge = vec3(0.039, 0.051, 0.071);   // #0a0d12
  vec3 mid = vec3(0.075, 0.102, 0.149);    // #131a26
  vec3 c = mix(mid, edge, smoothstep(0.0, 0.9, d));

  // Stars: one candidate per 22 CSS px cell, a third of the cells lit, each a soft
  // dot 1-2 px wide at a random brightness. Faint on purpose: a backdrop, not a sky map.
  float cell = 22.0 * u_px;
  vec2 g = floor(gl_FragCoord.xy / cell);
  float h = hash(g);
  if (h > 0.66) {
    vec2 centre = (g + vec2(hash(g + 1.7), hash(g + 9.1))) * cell;
    float r = (0.6 + 0.9 * hash(g + 3.3)) * u_px;
    float dist = length(gl_FragCoord.xy - centre);
    float star = 1.0 - smoothstep(0.0, r, dist);
    float bright = 0.12 + 0.3 * hash(g + 5.5);
    // Slightly warm or cool, like real stars.
    vec3 tint = mix(vec3(0.85, 0.9, 1.0), vec3(1.0, 0.95, 0.85), step(0.5, hash(g + 7.7)));
    c += tint * star * bright * u_stars;
  }
  color = vec4(c, 1.0);
}`;

export const SPACE_LAYER = 'he-space';

function compile(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

export function spaceLayer({ stars = true } = {}) {
  let program = null;
  let uSize, uPx, uStars;
  return {
    id: SPACE_LAYER,
    type: 'custom',
    renderingMode: '2d',
    onAdd(map, gl) {
      program = gl.createProgram();
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      uSize = gl.getUniformLocation(program, 'u_size');
      uPx = gl.getUniformLocation(program, 'u_px');
      uStars = gl.getUniformLocation(program, 'u_stars');
      this.map = map;
    },
    onRemove(map, gl) {
      if (program) gl.deleteProgram(program);
      program = null;
    },
    render(gl) {
      if (!program) return;
      const canvas = gl.canvas;
      gl.useProgram(program);
      gl.uniform2f(uSize, canvas.width, canvas.height);
      gl.uniform1f(uPx, canvas.width / Math.max(1, canvas.clientWidth || canvas.width));
      gl.uniform1f(uStars, stars ? 1 : 0);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.BLEND);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
