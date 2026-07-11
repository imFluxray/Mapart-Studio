// Minecraft view: fly-around voxel preview of the actual build (art blocks +
// noobline + supports at their real heights). Top faces use the exact final
// map color (shade included) so looking straight down matches the map view;
// side faces use the block's base color with per-direction light baked in.
// three.js is loaded lazily from the CDN importmap on first use.

import { BASE_COLORS, shadeRGB } from './palette.js';

let THREE = null, OrbitControls = null;
async function ensureThree() {
  if (THREE) return;
  THREE = await import('three');
  ({ OrbitControls } = await import('three/addons/controls/OrbitControls.js'));
}

const FACES = [
  // [dx,dy,dz, light, corner offsets ×4 (x,y,z each)]
  [0, 1, 0, 1.00, [0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1]],   // top
  [0, -1, 0, 0.38, [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]],  // bottom
  [1, 0, 0, 0.68, [1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1]],   // east
  [-1, 0, 0, 0.68, [0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1]],  // west
  [0, 0, -1, 0.55, [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]],  // north (darker)
  [0, 0, 1, 0.85, [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]],   // south (lit)
];
const SUPPORT_SIDE = [104, 108, 116];
const SUPPORT_TOP = [126, 130, 138];
const MAX_BLOCKS = 800_000;
const MAX_VOLUME = 48_000_000;

export class Viewer3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.result = null;
    this.dirty = true;
    this.active = false;
    this.renderer = null;
    this.mesh = null;
    this.helpers = [];
    this.raf = 0;
  }

  setResult(result) {
    this.result = result;
    this.dirty = true;
    if (this.active) this.rebuild();
  }

  async show(result) {
    await ensureThree();
    this.result = result ?? this.result;
    if (!this.renderer) this.initScene();
    this.active = true;
    if (this.dirty) this.rebuild();
    this.resize();
    this.loop();
  }

  hide() {
    this.active = false;
    cancelAnimationFrame(this.raf);
  }

  initScene() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0c0d11);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 8000);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.listenToKeyEvents(window); // arrow keys pan/fly
    new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement);
  }

  resize() {
    if (!this.renderer) return;
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clearBuild() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
    for (const h of this.helpers) this.scene.remove(h);
    this.helpers = [];
  }

  rebuild() {
    this.dirty = false;
    this.clearBuild();
    const r = this.result;
    if (!r) return (this.lastBuild = { blocks: 0 });

    const W = r.width, D = r.height + 1, Y = Math.max(1, r.ySize);
    if (r.totalBlocks > MAX_BLOCKS || W * D * Y > MAX_VOLUME) {
      return (this.lastBuild = { tooBig: true, blocks: r.totalBlocks });
    }

    // voxel occupancy: -1 empty, -2 support/noobline, ≥0 palette entry
    const occ = new Int32Array(W * D * Y).fill(-1);
    const K = (x, y, z) => (y * D + z) * W + x;
    const placed = [];
    for (let x = 0; x < W; x++) {
      if (r.noob[x] >= 0) { const k = K(x, r.noob[x] + r.yOffset, 0); occ[k] = -2; placed.push(x, r.noob[x] + r.yOffset, 0); }
    }
    for (let z = 0; z < r.height; z++) {
      for (let x = 0; x < W; x++) {
        const gi = z * W + x;
        if (r.grid[gi] < 0) continue;
        const y = r.heights[gi] + r.yOffset;
        occ[K(x, y, z + 1)] = r.grid[gi];
        placed.push(x, y, z + 1);
        if (r.needsSupport(r.palette[r.grid[gi]].block) && y > 0 && occ[K(x, y - 1, z + 1)] === -1) {
          occ[K(x, y - 1, z + 1)] = -2;
          placed.push(x, y - 1, z + 1);
        }
      }
    }

    // emit only exposed faces
    const pos = [], col = [], idx = [];
    const ox = -W / 2, oz = -D / 2;
    for (let p = 0; p < placed.length; p += 3) {
      const x = placed[p], y = placed[p + 1], z = placed[p + 2];
      const val = occ[K(x, y, z)];
      let topC, sideC;
      if (val >= 0) {
        topC = r.palette[val].rgb;
        sideC = shadeRGB(BASE_COLORS[r.palette[val].colorId].rgb, 1);
      } else { topC = SUPPORT_TOP; sideC = SUPPORT_SIDE; }
      for (const [dx, dy, dz, light, c] of FACES) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx >= 0 && nx < W && ny >= 0 && ny < Y && nz >= 0 && nz < D && occ[K(nx, ny, nz)] !== -1) continue;
        const src = dy === 1 ? topC : sideC;
        const cr = src[0] * light / 255, cg = src[1] * light / 255, cb = src[2] * light / 255;
        const base = pos.length / 3;
        for (let v = 0; v < 4; v++) {
          pos.push(x + c[v * 3] + ox, y + c[v * 3 + 1], z + c[v * 3 + 2] + oz);
          col.push(cr, cg, cb);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geo, mat);
    this.scene.add(this.mesh);

    // ground grid + north arrow
    const span = Math.max(W, D) + 32;
    const grid = new THREE.GridHelper(span, Math.round(span / 16), 0x2e3442, 0x1b1f29);
    grid.position.y = -0.51;
    this.scene.add(grid);
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0.5, oz - 5), 10, 0x9fe870, 4, 2.5,
    );
    this.scene.add(arrow);
    this.helpers.push(grid, arrow);

    // frame the build: high south-east three-quarter view
    const dist = Math.max(W, D, Y * 1.5);
    this.camera.position.set(W * 0.35, dist * 1.05, D * 0.5 + dist * 0.75);
    this.controls.target.set(0, Y / 4, 0);
    this.scene.fog = new THREE.Fog(0x0c0d11, dist * 3, dist * 8);
    this.controls.update();
    return (this.lastBuild = { blocks: placed.length / 3, faces: idx.length / 6, ySize: Y });
  }

  loop() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.active) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }
}
