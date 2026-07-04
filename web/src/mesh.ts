// Procedural "model railway" subway train: several chamfered cars in a row
// (trapezoidal cross-section — wider at the floor, narrower roof — reads as a
// train, not a box). Units are meters; SimpleMeshLayer scales via sizeScale.
// Returns a luma.gl Geometry (deck.gl v9 wants a Geometry, not a raw object).

import { Geometry } from "@luma.gl/engine";

export function trainMesh(): Geometry {
  const CARS = 6;
  const carLen = 22;
  const gap = 3;
  const W = 6.5; // half floor width
  const Wt = 4.2; // half roof width
  const H = 11; // height
  const total = CARS * carLen + (CARS - 1) * gap;
  const x0 = -total / 2;

  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];

  const tri = (a: number[], b: number[], c: number[]) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const v of [a, b, c]) { pos.push(v[0], v[1], v[2]); nor.push(nx, ny, nz); uv.push(0, 0); }
  };
  const quad = (a: number[], b: number[], c: number[], d: number[]) => { tri(a, b, c); tri(a, c, d); };

  for (let i = 0; i < CARS; i++) {
    const ax = x0 + i * (carLen + gap);
    const bx = ax + carLen;
    // slight nose taper on the first/last car ends
    const frontCab = i === CARS - 1 ? 4 : 0;
    const backCab = i === 0 ? 4 : 0;
    // 8 corners: floor (W) and roof (Wt)
    const fbl = [ax + backCab, -W, 0], fbr = [ax + backCab, W, 0];
    const nbl = [bx - frontCab, -W, 0], nbr = [bx - frontCab, W, 0];
    const ftl = [ax + backCab, -Wt, H], ftr = [ax + backCab, Wt, H];
    const ntl = [bx - frontCab, -Wt, H], ntr = [bx - frontCab, Wt, H];
    quad(fbl, fbr, nbr, nbl);       // floor
    quad(ftl, ntl, ntr, ftr);       // roof
    quad(fbl, nbl, ntl, ftl);       // left side
    quad(fbr, ftr, ntr, nbr);       // right side
    quad(fbl, ftl, ftr, fbr);       // back end
    quad(nbl, nbr, ntr, ntl);       // front end
  }

  return new Geometry({
    topology: "triangle-list",
    attributes: {
      positions: { size: 3, value: new Float32Array(pos) },
      normals: { size: 3, value: new Float32Array(nor) },
      texCoords: { size: 2, value: new Float32Array(uv) },
    },
  });
}

// Short chamfered box — a bus. Long axis is +X (direction of travel).
export function busMesh(): Geometry {
  const L = 7, W = 2.4, Wt = 1.9, H = 3.4; // half-dims (meters)
  const pos: number[] = [], nor: number[] = [], uv: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (const v of [a, b, c]) { pos.push(v[0], v[1], v[2]); nor.push(nx, ny, nz); uv.push(0, 0); }
  };
  const quad = (a: number[], b: number[], c: number[], d: number[]) => { tri(a, b, c); tri(a, c, d); };
  const fbl = [-L, -W, 0], fbr = [-L, W, 0], nbl = [L, -W, 0], nbr = [L, W, 0];
  const ftl = [-L, -Wt, H], ftr = [-L, Wt, H], ntl = [L, -Wt, H], ntr = [L, Wt, H];
  quad(fbl, fbr, nbr, nbl); quad(ftl, ntl, ntr, ftr);
  quad(fbl, nbl, ntl, ftl); quad(fbr, ftr, ntr, nbr);
  quad(fbl, ftl, ftr, fbr); quad(nbl, nbr, ntr, ntl);
  return new Geometry({
    topology: "triangle-list",
    attributes: {
      positions: { size: 3, value: new Float32Array(pos) },
      normals: { size: 3, value: new Float32Array(nor) },
      texCoords: { size: 2, value: new Float32Array(uv) },
    },
  });
}
