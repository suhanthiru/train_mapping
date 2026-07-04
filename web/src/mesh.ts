// Procedural low-poly "model railway" train mesh — an elongated box with a
// tapered nose. Units are meters; SimpleMeshLayer scales via sizeScale.
// Returns a luma.gl Geometry (deck.gl v9 SimpleMeshLayer wants a Geometry,
// not a raw {positions,...} object). Non-indexed (each face has its own verts).

import { Geometry } from "@luma.gl/engine";

export function trainMesh(): Geometry {
  const L = 90; // half-length ~180m
  const W = 7; // half-width
  const H = 6; // half-height
  const nose = 30;

  const v: number[][] = [
    [-L, -W, -H], [-L, W, -H], [-L, W, H], [-L, -W, H],
    [L - nose, -W, -H], [L - nose, W, -H], [L - nose, W, H], [L - nose, -W, H],
    [L, -W * 0.5, 0], [L, W * 0.5, 0],
  ];

  const faces: number[][] = [
    [0, 1, 2], [0, 2, 3],
    [0, 4, 5], [0, 5, 1],
    [3, 2, 6], [3, 6, 7],
    [1, 5, 6], [1, 6, 2],
    [0, 3, 7], [0, 7, 4],
    [4, 7, 8], [7, 9, 8], [4, 8, 9], [4, 9, 5],
    [5, 9, 6], [6, 9, 7],
  ];

  const n = faces.length * 3;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const texCoords = new Float32Array(n * 2);
  let p = 0;
  let t = 0;
  for (const f of faces) {
    const a = v[f[0]], b = v[f[1]], c = v[f[2]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const vert of [a, b, c]) {
      positions[p] = vert[0]; positions[p + 1] = vert[1]; positions[p + 2] = vert[2];
      normals[p] = nx; normals[p + 1] = ny; normals[p + 2] = nz;
      texCoords[t] = 0; texCoords[t + 1] = 0;
      p += 3; t += 2;
    }
  }

  return new Geometry({
    topology: "triangle-list",
    attributes: {
      positions: { size: 3, value: positions },
      normals: { size: 3, value: normals },
      texCoords: { size: 2, value: texCoords },
    },
  });
}
