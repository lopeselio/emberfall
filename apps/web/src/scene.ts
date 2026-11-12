import * as THREE from 'three';
import { BRAZIER, CENTER, DIAG, PILLAR, SIZE, SPEED, TICK_HZ, TILE, TREE, WALL, VIEW, makeArena, type SimEvent, type Tile, type View, type WardenView } from '@emberfall/rules';

// The arena at night, built from voxels. Moonlight shows the ruins dimly; your torch lights a warm
// circle and a world-space fog-of-war term greys out everything beyond it. Outside the closing ring
// the ground sinks into violet dark. Everything is procedural boxes; no model files.

const U = 1 / TILE; // sim units -> world units (1 tile = 1)
const C = {
  sky: 0x07060d, ground: 0x0c0b12,
  stone: [0x5b5866, 0x4f4c5a, 0x67636f, 0x47444f], moss: [0x3d4a33, 0x34402c], floor: [0x3a3842, 0x34323b, 0x403d47, 0x2f2d36],
  bark: 0x3b2a1f, barkDark: 0x2a1d15, coal: 0xff5a1a, ember: 0xffa040, moon: 0xe9e6ff,
};
export const CLOAKS = [0x3f6fb5, 0xb5423f, 0x3fa566, 0xc49a3a, 0x8a4fc4, 0x3fb0aa];
export const FLAMES = [0xff8a2a, 0xffd34d, 0xff3b2f, 0xaee0ff];

const hash = (x: number, z: number, k = 0): number => {
  let h = (x * 374761393 + z * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// ---------- fog of war, injected into the terrain material ----------

const fow = {
  uTorch: { value: new THREE.Vector2(20, 20) },
  uR: { value: VIEW * U },
  uDark: { value: 21 },
  uCenter: { value: new THREE.Vector2(CENTER * U, CENTER * U) },
};

function fowMaterial<M extends THREE.Material = THREE.MeshLambertMaterial>(m: M = new THREE.MeshLambertMaterial({ color: 0xffffff }) as unknown as M): M {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, fow);
    sh.vertexShader = `varying vec3 vFowPos;\n${sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      vec4 fowP = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        fowP = instanceMatrix * fowP;
      #endif
      vFowPos = (modelMatrix * fowP).xyz;`)}`;
    sh.fragmentShader = `uniform vec2 uTorch; uniform float uR; uniform float uDark; uniform vec2 uCenter;\nvarying vec3 vFowPos;\n${sh.fragmentShader.replace('#include <dithering_fragment>', `
      float fd = distance(vFowPos.xz, uTorch);
      float lit = 1.0 - smoothstep(uR * 0.7, uR, fd);
      float lum = dot(gl_FragColor.rgb, vec3(0.3, 0.55, 0.15));
      vec3 unseen = vec3(lum) * vec3(0.6, 0.68, 1.0) * 0.82 + vec3(0.006, 0.008, 0.02);
      gl_FragColor.rgb = mix(unseen, gl_FragColor.rgb, lit);
      float dc = distance(vFowPos.xz, uCenter);
      float dk = smoothstep(uDark - 0.3, uDark + 1.4, dc);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.03, 0.012, 0.055), dk * 0.9);
      #include <dithering_fragment>`)}`;
  };
  return m;
}

// ---------- pooled voxel particles ----------

interface Particle { i: number; life: number; max: number; vel: THREE.Vector3; pos: THREE.Vector3; size: number; color: THREE.Color; grav: number }

class Particles {
  mesh: THREE.InstancedMesh;
  private free: number[] = [];
  private live: Particle[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private col = new THREE.Color();
  constructor(scene: THREE.Scene, n = 1400) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < n; i++) { this.free.push(i); this.mesh.setMatrixAt(i, zero); this.mesh.setColorAt(i, this.col.set(0)); }
    scene.add(this.mesh);
  }
  spawn(pos: THREE.Vector3, vel: THREE.Vector3, color: number, size: number, life: number, grav = 0): void {
    const i = this.free.pop();
    if (i === undefined) return;
    this.live.push({ i, life, max: life, vel, pos: pos.clone(), size, color: new THREE.Color(color), grav });
  }
  burst(at: THREE.Vector3, color: number, n: number, speed = 2.5, size = 0.09, life = 0.7, grav = 5): void {
    for (let k = 0; k < n; k++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * speed, Math.random() * speed * 0.9 + 0.6, (Math.random() - 0.5) * speed);
      this.spawn(at, v, color, size * (0.6 + Math.random() * 0.8), life * (0.6 + Math.random() * 0.6), grav);
    }
  }
  update(dt: number): void {
    const keep: Particle[] = [];
    for (const p of this.live) {
      p.life -= dt;
      if (p.life <= 0) { this.mesh.setMatrixAt(p.i, this.m.makeScale(0, 0, 0)); this.free.push(p.i); continue; }
      p.vel.y -= p.grav * dt;
      p.pos.addScaledVector(p.vel, dt);
      const t = p.life / p.max;
      const sz = Math.max(0.001, p.size * (0.3 + 0.7 * t));
      this.m.compose(p.pos, this.q, this.s.set(sz, sz, sz));
      this.mesh.setMatrixAt(p.i, this.m);
      this.mesh.setColorAt(p.i, this.col.copy(p.color).multiplyScalar(0.4 + 0.6 * t));
      keep.push(p);
    }
    this.live = keep;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ---------- a Warden, in voxels ----------

interface Body {
  g: THREE.Group; legL: THREE.Mesh; legR: THREE.Mesh; arm: THREE.Group; flame: THREE.Mesh; flameTip: THREE.Mesh;
  body: THREE.Mesh; mats: THREE.MeshLambertMaterial[]; tag: THREE.Sprite; tagKey: string; flameColor: number;
}

const lam = (color: number, emissive = 0): THREE.MeshLambertMaterial => new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity: emissive ? 1 : 0 });
const bx = (w: number, h: number, d: number, m: THREE.Material): THREE.Mesh => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);

function buildWarden(seat: number, flame: number): Body {
  const g = new THREE.Group();
  const cloak = lam(CLOAKS[seat % CLOAKS.length]);
  const dark = lam(new THREE.Color(CLOAKS[seat % CLOAKS.length]).multiplyScalar(0.45).getHex());
  const skin = lam(0xd9b48f);
  const boot = lam(0x241c18);
  const legL = bx(0.16, 0.34, 0.18, boot); legL.position.set(-0.1, 0.17, 0); g.add(legL);
  const legR = legL.clone(); legR.position.x = 0.1; g.add(legR);
  const body = bx(0.46, 0.5, 0.3, cloak); body.position.y = 0.58; g.add(body);
  const hem = bx(0.5, 0.12, 0.34, dark); hem.position.y = 0.36; g.add(hem);
  const head = bx(0.3, 0.28, 0.28, skin); head.position.y = 0.98; g.add(head);
  const hood = bx(0.36, 0.2, 0.34, dark); hood.position.set(0, 1.14, -0.02); g.add(hood);
  const hoodBack = bx(0.36, 0.3, 0.1, dark); hoodBack.position.set(0, 1.0, -0.16); g.add(hoodBack);
  const eyeM = lam(0x120d0a);
  const e1 = bx(0.05, 0.05, 0.02, eyeM); e1.position.set(-0.07, 1.0, 0.145); g.add(e1);
  const e2 = e1.clone(); e2.position.x = 0.07; g.add(e2);
  // the torch arm (pivots at the shoulder; swings forward)
  const arm = new THREE.Group();
  arm.position.set(0.3, 0.78, 0.02);
  const sleeve = bx(0.13, 0.32, 0.13, cloak); sleeve.position.y = -0.12; arm.add(sleeve);
  const stick = bx(0.06, 0.55, 0.06, lam(0x6b4426)); stick.position.set(0, 0.06, 0.16); stick.rotation.x = 0.35; arm.add(stick);
  const fc = FLAMES[flame] ?? FLAMES[0];
  const flameM = new THREE.MeshBasicMaterial({ color: fc, toneMapped: false });
  const fl = bx(0.16, 0.18, 0.16, flameM); fl.position.set(0, 0.36, 0.27); arm.add(fl);
  const tipM = new THREE.MeshBasicMaterial({ color: new THREE.Color(fc).lerp(new THREE.Color(0xffffff), 0.55), toneMapped: false });
  const tip = bx(0.09, 0.12, 0.09, tipM); tip.position.set(0, 0.5, 0.3); arm.add(tip);
  g.add(arm);
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false }));
  tag.position.y = 1.65; tag.renderOrder = 10; g.add(tag);
  return { g, legL, legR, arm, flame: fl, flameTip: tip, body, mats: [cloak, dark, skin, boot], tag, tagKey: '', flameColor: fc };
}

function drawTag(b: Body, name: string, hp: number, max: number, embers: number, me: boolean): void {
  const key = `${name}|${hp}|${max}|${embers}|${me}`;
  if (b.tagKey === key) return;
  b.tagKey = key;
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 72;
  const x = cv.getContext('2d')!;
  x.font = '600 26px "Pixelify Sans", monospace';
  x.textAlign = 'center';
  x.fillStyle = 'rgba(0,0,0,.55)';
  x.fillText(name, 129, 28);
  x.fillStyle = me ? '#ffd08a' : '#f1e9ff';
  x.fillText(name, 128, 26);
  // one pip per heart the match's rules give (5 before v4, 8 from v4)
  const left = 128 - (max * 20 - 4) / 2;
  for (let k = 0; k < max; k++) { x.fillStyle = k < hp ? '#ff4d5a' : 'rgba(255,255,255,.18)'; x.fillRect(left + k * 20, 40, 16, 12); }
  if (embers > 0) { x.fillStyle = '#ffb347'; x.font = '600 20px "Pixelify Sans", monospace'; x.fillText(`◆${embers}`, 128, 70); }
  const old = (b.tag.material as THREE.SpriteMaterial).map;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  (b.tag.material as THREE.SpriteMaterial).map = tex;
  (b.tag.material as THREE.SpriteMaterial).needsUpdate = true;
  old?.dispose();
  b.tag.scale.set(1.6, 0.45, 1);
}

interface Shown {
  body: Body; seat: number;
  from: THREE.Vector3; to: THREE.Vector3; t: number;
  yaw: number; moving: number; walk: number; swing: number; flash: number; alive: boolean; seen: number;
}

// ---------- the world ----------

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(44, 1, 0.1, 300);
  private clock = new THREE.Clock();
  private terrainMat = fowMaterial();
  private terrain: THREE.Object3D[] = [];
  private particles: Particles;
  private lights: THREE.PointLight[] = [];
  private brazierLights: THREE.Vector3[] = [];
  private shown = new Map<number, Shown>();
  private emberMesh: THREE.InstancedMesh;
  private emberGlow: THREE.Points;
  private embers: { id: number; x: number; z: number }[] = [];
  private ring: THREE.Mesh;
  private ringMat: THREE.ShaderMaterial;
  private arcs: { mesh: THREE.Mesh; t: number }[] = [];
  private numbers: { s: THREE.Sprite; t: number; v: THREE.Vector3 }[] = [];
  private aimMark: THREE.Mesh;
  private hitStop = 0;
  private dust = 0;
  /** your own input, for prediction: the server is authoritative, this only hides the round trip */
  private input = { mx: 0, mz: 0, dash: 0 };
  private lastSnap = 0;
  private serverMe = new THREE.Vector3();
  /** -1..1 per axis: where you're aiming (for the marker and the camera lead) */
  aim = { x: 0, z: 1 };
  private camPos = new THREE.Vector3(20, 22, 40);
  private camLook = new THREE.Vector3(20, 0, 20);
  private shake = 0;
  private you = -1;
  /** a full heart bar under this match's rules */
  private maxHp = 5;
  private flames: number[] = [];
  private names: string[] = [];
  private darkR = 21;
  private mode: 'title' | 'match' = 'title';
  private m4 = new THREE.Matrix4();
  private tmp = new THREE.Vector3();
  /** called for each event the view brings (for sound) */
  onEvent: ((e: SimEvent, mine: boolean) => void) | null = null;

  constructor(host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(C.sky);
    this.scene.fog = new THREE.FogExp2(C.sky, 0.022);

    this.scene.add(new THREE.HemisphereLight(0x6a78b8, 0x14101f, 2.1));
    const moon = new THREE.DirectionalLight(0xb4c2ff, 1.75);
    moon.position.set(-14, 26, -18);
    this.scene.add(moon);
    // a fixed pool of torch lights, so shaders never recompile when torches come and go
    for (let k = 0; k < 7; k++) {
      const l = new THREE.PointLight(0xff8a3a, 0, 11, 1.25);
      this.scene.add(l);
      this.lights.push(l);
    }

    this.particles = new Particles(this.scene);
    const eg = new THREE.BoxGeometry(0.2, 0.2, 0.2);
    this.emberMesh = new THREE.InstancedMesh(eg, new THREE.MeshBasicMaterial({ color: C.ember, toneMapped: false }), 128);
    this.emberMesh.count = 0;
    this.emberMesh.frustumCulled = false;
    this.scene.add(this.emberMesh);
    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(140 * 3), 3));
    glowGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(140 * 3), 3));
    this.emberGlow = new THREE.Points(glowGeo, new THREE.PointsMaterial({ size: 1.6, map: glowTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, toneMapped: false }));
    this.emberGlow.frustumCulled = false;
    this.scene.add(this.emberGlow);

    this.ringMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uWarn: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec2 vUv; uniform float uTime; uniform float uWarn;
        float n(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
        void main(){
          vec2 q = vec2(floor(vUv.x * 160.0), floor(vUv.y * 10.0 - uTime * 1.6));
          float a = pow(1.0 - vUv.y, 1.3) * (0.45 + 0.55 * n(q));
          vec3 c = mix(vec3(0.05,0.02,0.09), vec3(0.32,0.12,0.5), n(q + 3.1) * (1.0 - vUv.y));
          float pulse = uWarn * (0.5 + 0.5 * sin(uTime * 9.0));
          c += vec3(0.55, 0.15, 0.85) * pulse * (1.0 - vUv.y);
          gl_FragColor = vec4(c, min(1.0, a * (0.85 + pulse * 0.6)));
        }`,
    });
    this.ring = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 4.5, 128, 1, true), this.ringMat);
    this.ring.position.set(CENTER * U, 2.25, CENTER * U);
    this.scene.add(this.ring);
    // a little wedge on the ground showing where your swing will land
    const wedge = new THREE.Shape();
    wedge.moveTo(-0.22, 0.7); wedge.lineTo(0, 1.05); wedge.lineTo(0.22, 0.7); wedge.lineTo(-0.22, 0.7);
    this.aimMark = new THREE.Mesh(new THREE.ShapeGeometry(wedge), new THREE.MeshBasicMaterial({ color: 0xffc070, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    this.aimMark.rotation.x = -Math.PI / 2;
    this.aimMark.visible = false;
    const aimHolder = new THREE.Group();
    aimHolder.add(this.aimMark);
    aimHolder.name = 'aim';
    this.scene.add(aimHolder);

    this.buildSky();
    this.setTiles(makeArena('emberfall-title').tiles);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private resize(): void {
    const w = this.renderer.domElement.parentElement?.clientWidth ?? window.innerWidth;
    const h = this.renderer.domElement.parentElement?.clientHeight ?? window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    // narrow screens: pull back so the torch circle fits
    this.camera.fov = w < h ? 58 : 44;
    this.camera.updateProjectionMatrix();
  }

  private buildSky(): void {
    const n = 900;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI * 0.42;
      const r = 140;
      pos[i * 3] = 20 + r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = 10 + r * Math.cos(ph);
      pos[i * 3 + 2] = 20 + r * Math.sin(ph) * Math.sin(th);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xcfd6ff, size: 0.55, fog: false, sizeAttenuation: true })));
    // a blocky moon
    const moon = new THREE.Group();
    const mm = new THREE.MeshBasicMaterial({ color: C.moon, fog: false, toneMapped: false });
    const cm = new THREE.MeshBasicMaterial({ color: 0xbdb8dd, fog: false, toneMapped: false });
    for (let x = -3; x <= 3; x++) for (let y = -3; y <= 3; y++) {
      if (x * x + y * y > 11) continue;
      const v = bx(1, 1, 0.6, (x * 7 + y * 3) % 5 === 0 ? cm : mm);
      v.position.set(x, y, 0);
      moon.add(v);
    }
    moon.position.set(-40, 62, -70);
    moon.lookAt(20, 0, 20);
    this.scene.add(moon);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0x8a90ff, transparent: true, opacity: 0.35, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }));
    halo.scale.set(34, 34, 1);
    halo.position.copy(moon.position);
    this.scene.add(halo);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshLambertMaterial({ color: C.ground }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(20, -0.42, 20);
    this.scene.add(ground);
  }

  /** Builds the terrain voxels for an arena (public: every client gets the tiles at the start). */
  setTiles(tiles: Tile[]): void {
    for (const o of this.terrain) { this.scene.remove(o); (o as THREE.Mesh).geometry?.dispose(); }
    this.terrain = [];
    this.brazierLights = [];
    const floor = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.4, 1), this.terrainMat, SIZE * SIZE);
    const vox: { x: number; y: number; z: number; sx: number; sy: number; sz: number; c: number }[] = [];
    const col = new THREE.Color();
    let i = 0;
    for (let tz = 0; tz < SIZE; tz++) for (let tx = 0; tx < SIZE; tx++) {
      const h = hash(tx, tz);
      const mossy = hash(tx, tz, 3) < 0.18;
      const c = mossy ? C.moss[h < 0.5 ? 0 : 1] : C.floor[Math.floor(h * 4)];
      this.m4.makeTranslation(tx + 0.5, -0.2 + (h - 0.5) * 0.06, tz + 0.5);
      floor.setMatrixAt(i, this.m4);
      floor.setColorAt(i, col.set(c));
      i++;
      const t = tiles[tz * SIZE + tx];
      const r = hash(tx, tz, 7);
      if (t === 0) {
        // tufts and pebbles
        if (r < 0.12) vox.push({ x: tx + 0.2 + r * 4, y: 0.06, z: tz + 0.3 + hash(tx, tz, 9) * 0.4, sx: 0.12, sy: 0.12, sz: 0.12, c: mossy ? 0x4c5e3a : 0x55525d });
        continue;
      }
      if (t === WALL) {
        const border = tx === 0 || tz === 0 || tx === SIZE - 1 || tz === SIZE - 1;
        const levels = border ? 6 : 3 + Math.floor(r * 2);
        for (let y = 0; y < levels; y++) for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
          const k = hash(tx * 2 + a, tz * 2 + b, y);
          if (y === levels - 1 && k < 0.35) continue; // crumbled top
          vox.push({ x: tx + 0.25 + a * 0.5, y: 0.25 + y * 0.5, z: tz + 0.25 + b * 0.5, sx: 0.49, sy: 0.48, sz: 0.49, c: C.stone[Math.floor(k * 4)] });
        }
        if (!border && r < 0.4) vox.push({ x: tx + 0.5 + (r - 0.2) * 2, y: 0.08, z: tz + 1.05, sx: 0.22, sy: 0.16, sz: 0.2, c: C.stone[1] });
      } else if (t === PILLAR) {
        for (let y = 0; y < 7; y++) vox.push({ x: tx + 0.5, y: 0.25 + y * 0.5, z: tz + 0.5, sx: 0.62, sy: 0.49, sz: 0.62, c: C.stone[(y + Math.floor(r * 4)) % 4] });
        vox.push({ x: tx + 0.5, y: 0.15, z: tz + 0.5, sx: 0.86, sy: 0.3, sz: 0.86, c: C.stone[3] });
        if (r > 0.3) vox.push({ x: tx + 0.5, y: 3.6, z: tz + 0.5, sx: 0.9, sy: 0.25, sz: 0.9, c: C.stone[2] });
      } else if (t === TREE) {
        const hgt = 2.4 + r * 1.2;
        vox.push({ x: tx + 0.5, y: hgt / 2, z: tz + 0.5, sx: 0.3, sy: hgt, sz: 0.3, c: C.bark });
        for (let k = 0; k < 4; k++) {
          const a = hash(tx, tz, 20 + k), side = k % 2 ? 1 : -1;
          const along = k < 2;
          vox.push({ x: tx + 0.5 + (along ? side * 0.35 : 0), y: hgt * (0.55 + a * 0.4), z: tz + 0.5 + (along ? 0 : side * 0.35), sx: along ? 0.5 : 0.12, sy: 0.12, sz: along ? 0.12 : 0.5, c: C.barkDark });
          vox.push({ x: tx + 0.5 + (along ? side * 0.6 : 0), y: hgt * (0.55 + a * 0.4) + 0.2, z: tz + 0.5 + (along ? 0 : side * 0.6), sx: 0.1, sy: 0.35, sz: 0.1, c: C.barkDark });
        }
        vox.push({ x: tx + 0.5, y: 0.08, z: tz + 0.5, sx: 0.55, sy: 0.16, sz: 0.55, c: C.moss[1] });
      } else if (t === BRAZIER) {
        vox.push({ x: tx + 0.5, y: 0.25, z: tz + 0.5, sx: 0.5, sy: 0.5, sz: 0.5, c: C.stone[3] });
        vox.push({ x: tx + 0.5, y: 0.6, z: tz + 0.5, sx: 0.85, sy: 0.22, sz: 0.85, c: C.stone[0] });
        this.brazierLights.push(new THREE.Vector3(tx + 0.5, 1.0, tz + 0.5));
      }
    }
    floor.instanceMatrix.needsUpdate = true;
    this.scene.add(floor);
    this.terrain.push(floor);
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.terrainMat, vox.length);
    const q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    vox.forEach((v, k) => {
      this.m4.compose(p.set(v.x, v.y, v.z), q, s.set(v.sx, v.sy, v.sz));
      mesh.setMatrixAt(k, this.m4);
      mesh.setColorAt(k, col.set(v.c));
    });
    this.scene.add(mesh);
    this.terrain.push(mesh);
    // glowing coals in the braziers
    const coals = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.12, 0.5), fowMaterial(new THREE.MeshBasicMaterial({ color: C.coal, toneMapped: false })), this.brazierLights.length);
    this.brazierLights.forEach((b, k) => { this.m4.makeTranslation(b.x, 0.74, b.z); coals.setMatrixAt(k, this.m4); });
    this.scene.add(coals);
    this.terrain.push(coals);
  }

  // ---------- match state from the server ----------

  startMatch(tiles: Tile[], you: number, names: string[], flames: number[], maxHp = 5): void {
    this.mode = 'match';
    this.maxHp = maxHp;
    this.setTiles(tiles);
    this.you = you;
    this.names = names;
    this.flames = flames;
    for (const sh of this.shown.values()) this.scene.remove(sh.body.g);
    this.shown.clear();
    this.embers = [];
    this.darkR = 21;
  }

  toTitle(): void {
    this.mode = 'title';
    for (const sh of this.shown.values()) this.scene.remove(sh.body.g);
    this.shown.clear();
    this.embers = [];
    this.emberMesh.count = 0;
    this.darkR = 21;
    this.setTiles(makeArena('emberfall-title').tiles);
  }

  private show(w: WardenView, now: number): void {
    let sh = this.shown.get(w.seat);
    const pos = new THREE.Vector3(w.x * U, 0, w.z * U);
    if (!sh) {
      const body = buildWarden(w.seat, this.flames[w.seat] ?? w.flame);
      this.scene.add(body.g);
      body.g.position.copy(pos);
      sh = { body, seat: w.seat, from: pos.clone(), to: pos.clone(), t: 1, yaw: Math.atan2(w.fx, w.fz), moving: 0, walk: 0, swing: 0, flash: 0, alive: true, seen: now };
      this.shown.set(w.seat, sh);
    }
    sh.from.copy(sh.body.g.position);
    sh.to.copy(pos);
    sh.t = 0;
    if (w.seat === this.you) { this.serverMe.copy(pos); this.lastSnap = now; }
    sh.seen = now;
    sh.moving = sh.from.distanceTo(sh.to) > 0.01 ? 1 : 0;
    if (w.fx || w.fz) sh.yaw = Math.atan2(w.fx, w.fz);
    if (w.swingT >= 5) sh.swing = 1;
    sh.body.g.visible = w.alive;
    sh.alive = w.alive;
    if (w.grace > 0) sh.flash = Math.max(sh.flash, 0.3);
    drawTag(sh.body, w.name, w.hp, this.maxHp, w.embers, w.seat === this.you);
  }

  /** A new fogged view from the server. */
  update(v: View, events: SimEvent[]): void {
    const now = performance.now();
    this.show(v.me, now);
    for (const o of v.others) this.show(o, now);
    // Wardens that left the light fade out (we no longer know where they are)
    for (const [seat, sh] of this.shown) {
      if (seat !== this.you && sh.seen !== now) { this.scene.remove(sh.body.g); this.shown.delete(seat); }
    }
    this.embers = v.embers;
    this.darkR = v.darkR * U;
    for (const e of events) {
      const at = e.x >= 0 ? new THREE.Vector3(e.x * U, 0.6, e.z * U) : null;
      const mine = e.w === this.you || ('by' in e && e.by === this.you);
      this.onEvent?.(e, mine);
      if (!at) continue;
      if (e.t === 'pick') { this.particles.burst(at, 0xffc060, 12, 2.2, 0.08, 0.6, 3); if (e.w === this.you) this.number(at, '+1', '#ffc060'); }
      else if (e.t === 'hit') {
        this.particles.burst(at, 0xffffff, 6, 3, 0.07, 0.35, 6);
        this.particles.burst(at, 0xff4040, 8, 2.5, 0.1, 0.5, 7);
        const sh = this.shown.get(e.w);
        if (sh) sh.flash = 1;
        if (e.w === this.you) this.shake = 0.45;
        if (mine) { this.hitStop = 0.075; if (e.by === this.you) this.shake = Math.max(this.shake, 0.18); }
        this.number(at, '-1', e.w === this.you ? '#ff5a6a' : '#ffffff');
      } else if (e.t === 'fall') {
        this.particles.burst(at, 0x6a6470, 40, 2.2, 0.14, 1.4, 1.5);
        this.particles.burst(at, 0xff8a2a, 20, 3, 0.1, 0.9, 3);
        if (e.w === this.you) this.shake = 0.6;
      } else if (e.t === 'burn') { this.particles.burst(at, 0x8a3bd1, 12, 1.6, 0.1, 0.8, -1); this.number(at, '-1', '#c57bff'); if (e.w === this.you) this.shake = 0.3; }
      else if (e.t === 'dash') { for (let k = 0; k < 10; k++) this.particles.spawn(at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.4, -0.3, (Math.random() - 0.5) * 0.4)), new THREE.Vector3(0, 0.3, 0), 0xc8c0e0, 0.12, 0.5); }
      else if (e.t === 'swing') this.arc(e.w);
    }
  }

  private arc(seat: number): void {
    const sh = this.shown.get(seat);
    if (!sh) return;
    const m = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.55, 18, 1, -Math.PI / 2, Math.PI), new THREE.MeshBasicMaterial({ color: FLAMES[this.flames[seat] ?? 0], transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    m.rotation.x = -Math.PI / 2;
    const holder = new THREE.Group();
    holder.add(m);
    holder.position.copy(sh.to).setY(0.5);
    holder.rotation.y = sh.yaw - Math.PI / 2;
    this.scene.add(holder);
    this.arcs.push({ mesh: holder as unknown as THREE.Mesh, t: 0 });
  }

  /** A floating number (damage, pickups) that rises and fades. */
  private number(at: THREE.Vector3, text: string, color: string): void {
    const cv = document.createElement('canvas');
    cv.width = 96; cv.height = 64;
    const x = cv.getContext('2d')!;
    x.font = '700 44px "Pixelify Sans", monospace';
    x.textAlign = 'center';
    x.lineWidth = 6; x.strokeStyle = 'rgba(0,0,0,.7)'; x.strokeText(text, 48, 46);
    x.fillStyle = color; x.fillText(text, 48, 46);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    s.scale.set(0.9, 0.6, 1);
    s.renderOrder = 12;
    s.position.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 1.0, 0));
    this.scene.add(s);
    this.numbers.push({ s, t: 0, v: new THREE.Vector3(0, 1.6, 0) });
  }

  /** Your current input, for prediction (movement keys and dash). */
  setInput(mx: number, mz: number, dash = false): void {
    this.input.mx = mx; this.input.mz = mz;
    if (dash) this.input.dash = 0.25;
  }

  /** Where a screen point lands on the ground (for mouse aim). */
  groundAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.5), p) ? p : null;
  }

  /** World position of the local Warden (for the minimap and sound). */
  mePos(): THREE.Vector3 | null { return this.shown.get(this.you)?.body.g.position ?? null; }

  // ---------- per frame ----------

  private frame(): void {
    const realDt = Math.min(0.05, this.clock.getDelta());
    // hit-stop: a few frames of near-frozen time when your blow lands (or you're struck)
    const dt = this.hitStop > 0 ? realDt * 0.08 : realDt;
    this.hitStop = Math.max(0, this.hitStop - realDt);
    const time = this.clock.elapsedTime;
    this.input.dash = Math.max(0, this.input.dash - realDt);
    this.ringMat.uniforms.uTime.value = time;

    // move and animate the Wardens we can see
    for (const sh of this.shown.values()) {
      const b = sh.body;
      sh.t = Math.min(1, sh.t + dt / 0.05);
      if (sh.seat === this.you && sh.alive && this.mode === 'match') {
        // predict your own Warden from your keys for up to ~90 ms past the last view, then let the server win
        const age = Math.min(0.09, (performance.now() - this.lastSnap) / 1000);
        const sp = ((this.input.mx && this.input.mz ? DIAG : SPEED) * TICK_HZ * (this.input.dash > 0 ? 3 : 1)) / TILE;
        const want = this.tmp.copy(this.serverMe).add(new THREE.Vector3(this.input.mx * sp * age, 0, this.input.mz * sp * age));
        b.g.position.x += (want.x - b.g.position.x) * Math.min(1, dt * 22);
        b.g.position.z += (want.z - b.g.position.z) * Math.min(1, dt * 22);
      } else b.g.position.lerpVectors(sh.from, sh.to, sh.t);
      let dy = sh.yaw - b.g.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      b.g.rotation.y += dy * Math.min(1, dt * 16);
      if (sh.seat === this.you) sh.moving = this.input.mx || this.input.mz ? 1 : sh.moving;
      sh.walk += dt * (sh.moving ? 14 : 0);
      // footstep dust
      if (sh.moving && sh.alive && Math.random() < dt * (sh.seat === this.you ? 10 : 5)) {
        this.particles.spawn(this.tmp.copy(b.g.position).add(new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.05, (Math.random() - 0.5) * 0.3)), new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.4, (Math.random() - 0.5) * 0.4), 0x6b6478, 0.09, 0.45, 0.5);
      }
      const sw = Math.sin(sh.walk) * 0.5 * sh.moving;
      b.legL.rotation.x = sw;
      b.legR.rotation.x = -sw;
      b.g.position.y = Math.abs(Math.sin(sh.walk)) * 0.05 * sh.moving;
      sh.swing = Math.max(0, sh.swing - dt * 4);
      b.arm.rotation.x = sh.swing > 0 ? -Math.sin((1 - sh.swing) * Math.PI) * 1.9 : Math.sin(time * 2 + sh.seat) * 0.05;
      const fl = 0.85 + Math.sin(time * 23 + sh.seat * 3) * 0.12 + Math.sin(time * 37) * 0.06;
      b.flame.scale.set(fl, 0.8 + fl * 0.4, fl);
      b.flameTip.position.y = 0.5 + Math.sin(time * 19 + sh.seat) * 0.03;
      sh.flash = Math.max(0, sh.flash - dt * 3);
      for (const m of b.mats) m.emissive.setRGB(sh.flash * 0.9, sh.flash * 0.25, sh.flash * 0.2);
      if (sh.alive && Math.random() < dt * 9) {
        b.flame.getWorldPosition(this.tmp);
        this.particles.spawn(this.tmp, new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.9 + Math.random() * 0.6, (Math.random() - 0.5) * 0.3), b.flameColor, 0.05, 0.8);
      }
    }

    // torch lights: yours first, then the others in view, then braziers in the title scene
    let li = 0;
    const me = this.shown.get(this.you);
    const order = [...this.shown.values()].filter((s) => s.alive).sort((a, b) => (a.seat === this.you ? -1 : b.seat === this.you ? 1 : 0));
    for (const sh of order) {
      if (li >= this.lights.length) break;
      const l = this.lights[li++];
      sh.body.flame.getWorldPosition(l.position);
      l.position.y += 0.3;
      l.color.setHex(sh.body.flameColor);
      const flick = 1 + Math.sin(time * 17 + sh.seat) * 0.07 + Math.sin(time * 29 + sh.seat * 2) * 0.05;
      l.intensity = (sh.seat === this.you ? 26 : 16) * flick;
      l.distance = sh.seat === this.you ? 12 : 9;
    }
    if (this.mode === 'title' || !me) {
      for (const b of this.brazierLights) {
        if (li >= this.lights.length) break;
        const l = this.lights[li++];
        l.position.copy(b);
        l.color.setHex(0xff7a2a);
        l.intensity = 14 * (1 + Math.sin(time * 13 + b.x) * 0.08);
        l.distance = 10;
        if (Math.random() < dt * 6) this.particles.spawn(b, new THREE.Vector3((Math.random() - 0.5) * 0.4, 1 + Math.random(), (Math.random() - 0.5) * 0.4), 0xffa040, 0.06, 1.1);
      }
    }
    for (; li < this.lights.length; li++) this.lights[li].intensity = 0;

    // embers on the ground
    const q = new THREE.Quaternion();
    const s1 = new THREE.Vector3(1, 1, 1);
    const glowPos = this.emberGlow.geometry.getAttribute('position') as THREE.BufferAttribute;
    const glowCol = this.emberGlow.geometry.getAttribute('color') as THREE.BufferAttribute;
    let gi = 0;
    this.emberMesh.count = Math.min(128, this.embers.length);
    for (let k = 0; k < this.emberMesh.count; k++) {
      const e = this.embers[k];
      const y = 0.25 + Math.sin(time * 3 + e.id) * 0.07;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), time * 1.5 + e.id);
      this.m4.compose(this.tmp.set(e.x * U, y, e.z * U), q, s1);
      this.emberMesh.setMatrixAt(k, this.m4);
      glowPos.setXYZ(gi, e.x * U, y, e.z * U);
      glowCol.setXYZ(gi, 1, 0.5, 0.15);
      gi++;
      if (Math.random() < dt * 1.5) this.particles.spawn(this.tmp, new THREE.Vector3(0, 0.7, 0), 0xffb050, 0.05, 0.9);
    }
    this.emberMesh.instanceMatrix.needsUpdate = true;
    for (const sh of this.shown.values()) {
      if (!sh.alive || gi >= 139) continue;
      sh.body.flame.getWorldPosition(this.tmp);
      glowPos.setXYZ(gi, this.tmp.x, this.tmp.y, this.tmp.z);
      const c = new THREE.Color(sh.body.flameColor);
      glowCol.setXYZ(gi, c.r * 1.4, c.g * 1.4, c.b * 1.4);
      gi++;
    }
    this.emberGlow.geometry.setDrawRange(0, gi);
    glowPos.needsUpdate = true;
    glowCol.needsUpdate = true;

    // the dark: a smoky wall on the ring and violet smoke drifting off it near you
    this.ring.scale.set(this.darkR, 1, this.darkR);
    this.ring.visible = this.mode === 'match';
    fow.uDark.value = this.mode === 'match' ? this.darkR : 99;
    if (this.mode === 'match' && me) {
      const c = CENTER * U;
      const a0 = Math.atan2(me.body.g.position.z - c, me.body.g.position.x - c);
      for (let k = 0; k < 3; k++) {
        if (Math.random() > dt * 14) continue;
        const a = a0 + (Math.random() - 0.5) * 1.2;
        this.particles.spawn(new THREE.Vector3(c + Math.cos(a) * this.darkR, 0.2 + Math.random() * 1.5, c + Math.sin(a) * this.darkR), new THREE.Vector3(-Math.cos(a) * 0.15, 0.35, -Math.sin(a) * 0.15), 0x2a1340, 0.35, 1.8);
      }
    }

    for (const a of this.arcs) {
      a.t += dt;
      const mesh = a.mesh.children[0] as THREE.Mesh;
      (mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.55 * (1 - a.t / 0.18));
      if (a.t > 0.2) { this.scene.remove(a.mesh); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
    }
    this.arcs = this.arcs.filter((a) => a.t <= 0.2);
    for (const n of this.numbers) {
      n.t += realDt;
      n.s.position.addScaledVector(n.v, realDt);
      n.v.y = Math.max(0.2, n.v.y - realDt * 3);
      (n.s.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - n.t / 0.9);
      if (n.t > 0.9) { this.scene.remove(n.s); (n.s.material as THREE.SpriteMaterial).map?.dispose(); n.s.material.dispose(); }
    }
    this.numbers = this.numbers.filter((n) => n.t <= 0.9);
    const aimG = this.aimMark.parent!;
    this.aimMark.visible = this.mode === 'match' && !!me?.alive;
    if (me) { aimG.position.set(me.body.g.position.x, 0.03, me.body.g.position.z); aimG.rotation.y = Math.atan2(-this.aim.x, -this.aim.z); }
    (this.aimMark.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.25 * Math.sin(time * 6);
    // the dark warns when it's near you
    if (me && this.mode === 'match') {
      const c = CENTER * U;
      const dist = Math.hypot(me.body.g.position.x - c, me.body.g.position.z - c);
      this.ringMat.uniforms.uWarn.value = Math.max(0, Math.min(1, 1 - (this.darkR - dist) / 2.5));
    } else this.ringMat.uniforms.uWarn.value = 0;
    this.particles.update(dt);

    // camera: follow your Warden; orbit the ruins on the title screen
    if (this.mode === 'match' && me) {
      const p = me.body.g.position;
      fow.uTorch.value.set(p.x, p.z);
      fow.uR.value = VIEW * U;
      // lead the camera a little towards where you're heading / aiming
      const lx = (this.input.mx * 0.9 + this.aim.x * 0.6), lz = (this.input.mz * 0.9 + this.aim.z * 0.6);
      const wantPos = this.tmp.set(p.x + lx, p.y + 12.5, p.z + 9 + lz);
      this.camPos.lerp(wantPos, Math.min(1, realDt * 4));
      this.camLook.lerp(new THREE.Vector3(p.x + lx, 0, p.z - 0.6 + lz), Math.min(1, realDt * 4.5));
    } else {
      const a = time * 0.05;
      this.camPos.set(20 + Math.cos(a) * 24, 17, 20 + Math.sin(a) * 24);
      this.camLook.set(20, 0, 20);
      fow.uTorch.value.set(20, 20);
      fow.uR.value = 60;
    }
    this.camera.position.copy(this.camPos);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - realDt * 1.6);
      this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.5;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.5;
    }
    this.camera.lookAt(this.camLook);
    this.renderer.render(this.scene, this.camera);
  }
}

let glowTex: THREE.Texture | null = null;
function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const x = cv.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(cv);
  return glowTex;
}
