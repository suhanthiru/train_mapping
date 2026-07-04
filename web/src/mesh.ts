// Procedural low-poly "model railway" train mesh — an elongated box with a
// tapered nose. Units are meters; SimpleMeshLayer scales via sizeScale.
// Returns the attribute shape deck.gl/luma expects.

export function trainMesh() {
  // Half-extents (meters): long in X (direction of travel), narrow Y, short Z.
  const L = 90; // half-length ~180m train
  const W = 7; // half-width
  const H = 6; // half-height
  const nose = 30; // nose taper length

  // 10 vertices: a box with the +X face pinched into a nose point pair.
  // Define 8 box corners, then move the front (+X) top/bottom inward for a nose.
  const v: number[][] = [
    [-L, -W, -H], // 0 back-bottom-right
    [-L, W, -H], // 1 back-bottom-left
    [-L, W, H], // 2 back-top-left
    [-L, -W, H], // 3 back-top-right
    [L - nose, -W, -H], // 4 front-bottom-right
    [L - nose, W, -H], // 5 front-bottom-left
    [L - nose, W, H], // 6 front-top-left
    [L - nose, -W, H], // 7 front-top-right
    [L, -W * 0.5, 0], // 8 nose-right
    [L, W * 0.5, 0], // 9 nose-left
  ];

  const faces: number[][] = [
    [0, 1, 2], [0, 2, 3], // back
    [0, 4, 5], [0, 5, 1], // bottom-rear
    [3, 2, 6], [3, 6, 7], // top-rear
    [1, 5, 6], [1, 6, 2], // left-rear
    [0, 3, 7], [0, 7, 4], // right-rear
    [4, 7, 8], [7, 9, 8], [4, 8, 9], [4, 9, 5], // right nose wedge (approx)
    [5, 9, 6], [6, 9, 7], // left/top nose
  ];

  const positions = new Float32Array(faces.length * 9);
  const normals = new Float32Array(faces.length * 9);
  const texCoords = new Float32Array(faces.length * 6);
  const indices = new Uint16Array(faces.length * 3);
  let p = 0;
  let idx = 0;
  for (const f of faces) {
    const a = v[f[0]], b = v[f[1]], c = v[f[2]];
    // face normal
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
      indices[idx] = idx;
      p += 3; idx += 1;
    }
  }
  return { positions, normals, texCoords, indices };
}
