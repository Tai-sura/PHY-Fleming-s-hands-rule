import * as THREE from "three";

export type RigKind = "motor" | "generator";

export interface RigValues {
  B: number;
  I?: number;
  L: number;
  v?: number;
  thetaDeg: number;
}

export interface HandBasis {
  dirB: THREE.Vector3;
  dirMoving90: THREE.Vector3;
  dirResult: THREE.Vector3;
}

const COLOR_F = 0x3f48cc;
const COLOR_B = 0x0ed145;
const COLOR_I = 0xfa2e56;
const HEX_F = "#3f48cc";
const HEX_B = "#0a8a2e";
const HEX_I = "#fa2e56";

function makeLabel(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 256, 256);
  ctx.fillStyle = color;
  ctx.font = "bold 180px Times New Roman, serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 16;
  ctx.strokeText(text, 128, 140);
  ctx.fillText(text, 128, 140);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map, transparent: true, depthTest: false })
  );
  sprite.scale.set(0.09, 0.09, 0.09);
  sprite.renderOrder = 10;
  return sprite;
}

function makeArrow(color: number, length: number): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.08,
    roughness: 0.35,
    emissive: new THREE.Color(color),
    emissiveIntensity: 0.18,
  });
  const shaftLen = length * 0.72;
  const headLen = length * 0.28;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, shaftLen, 18), mat);
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.016, headLen, 18), mat);
  shaft.position.y = shaftLen / 2;
  head.position.y = shaftLen + headLen / 2;
  shaft.castShadow = true;
  head.castShadow = true;
  group.add(shaft, head);
  return group;
}

/**
 * Build an orthonormal teaching basis from the hand's baked arrows.
 * Moving (I or v) is the component of the 90° finger orthogonal to B.
 * Result (F or E) is moving × B, flipped if needed to match the hand.
 */
export function makeHandBasis(
  dirB: THREE.Vector3,
  dirMoving90: THREE.Vector3,
  dirResultHint: THREE.Vector3
): HandBasis {
  const B = dirB.clone().normalize();
  const moving = dirMoving90.clone().sub(B.clone().multiplyScalar(dirMoving90.dot(B)));
  if (moving.lengthSq() < 1e-8) {
    moving.crossVectors(dirResultHint, B);
  }
  moving.normalize();
  const result = new THREE.Vector3().crossVectors(moving, B).normalize();
  if (result.dot(dirResultHint) < 0) result.negate();
  return { dirB: B, dirMoving90: moving, dirResult: result };
}

/**
 * Interactive formula triad, aligned to the hand gesture.
 * At θ = 90°, B / I(v) / F(E) match the corresponding fingers.
 * I or v then rotates in the B–moving plane; F or E stays along the result finger.
 */
export class FormulaRig {
  readonly group = new THREE.Group();
  readonly kind: RigKind;
  private readonly arrowB: THREE.Group;
  private readonly arrowMoving: THREE.Group;
  private readonly arrowResult: THREE.Group;
  private readonly labelB: THREE.Sprite;
  private readonly labelMoving: THREE.Sprite;
  private readonly labelResult: THREE.Sprite;
  private readonly arc: THREE.Mesh;
  private readonly length: number;
  private readonly Y = new THREE.Vector3(0, 1, 0);
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private basis: HandBasis = {
    dirB: new THREE.Vector3(1, 0, 0),
    dirMoving90: new THREE.Vector3(0, 1, 0),
    dirResult: new THREE.Vector3(0, 0, 1),
  };

  constructor(kind: RigKind, length = 0.22) {
    this.kind = kind;
    this.length = length;
    this.group.name = `formula-rig-${kind}`;

    const movingColor = kind === "motor" ? COLOR_I : COLOR_F;
    const resultColor = kind === "motor" ? COLOR_F : COLOR_I;
    this.arrowB = makeArrow(COLOR_B, length);
    this.arrowMoving = makeArrow(movingColor, length);
    this.arrowResult = makeArrow(resultColor, length);

    this.labelB = makeLabel("B", HEX_B);
    this.labelMoving = makeLabel(kind === "motor" ? "I" : "v", kind === "motor" ? HEX_I : HEX_F);
    this.labelResult = makeLabel(kind === "motor" ? "F" : "E", kind === "motor" ? HEX_F : HEX_I);

    const arcMat = new THREE.MeshStandardMaterial({
      color: 0x445566,
      metalness: 0,
      roughness: 0.4,
      side: THREE.DoubleSide,
    });
    this.arc = new THREE.Mesh(new THREE.TorusGeometry(length * 0.46, 0.0035, 8, 48, Math.PI / 2), arcMat);

    this.group.add(
      this.arrowB,
      this.arrowMoving,
      this.arrowResult,
      this.labelB,
      this.labelMoving,
      this.labelResult,
      this.arc
    );
    this.update({ B: 1, I: 1, L: 0.1, v: 1, thetaDeg: 90 });
  }

  setBasis(basis: HandBasis): void {
    this.basis = basis;
  }

  getBasis(): HandBasis {
    return this.basis;
  }

  /**
   * Place the rig beside the hand (not above the thumb) so the default
   * view can show the whole gesture plus the formula triad.
   */
  placeBeside(model: THREE.Object3D, side: "left" | "right" = "left"): void {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z);
    const xOff = (side === "left" ? -0.50 : 0.50) * span;
    const world = new THREE.Vector3(center.x + xOff, center.y + size.y * 0.06, center.z);
    if (this.group.parent) {
      this.group.parent.updateWorldMatrix(true, true);
      this.group.parent.worldToLocal(world);
    }
    this.group.position.copy(world);
    this.group.scale.setScalar(span * 0.82);
  }

  update(values: RigValues): void {
    const theta = THREE.MathUtils.degToRad(values.thetaDeg);
    const sin = Math.sin(theta);
    const cos = Math.cos(theta);
    const magB = this.length * Math.min(1.15, 0.35 + 0.65 * (values.B / 2));
    const movingSrc = this.kind === "motor" ? values.I ?? 1 : values.v ?? 1;
    const movingMax = this.kind === "motor" ? 5 : 10;
    const magMoving = this.length * Math.min(1.15, 0.35 + 0.65 * (movingSrc / movingMax));
    const product =
      this.kind === "motor"
        ? values.B * (values.I ?? 0) * values.L * Math.abs(sin)
        : values.B * values.L * (values.v ?? 0) * Math.abs(sin);
    const productRef = this.kind === "motor" ? 1 * 1 * 0.1 * 1 : 1 * 0.1 * 1 * 1;
    const magResult = this.length * Math.min(1.2, (product / Math.max(productRef, 1e-6)) * 0.85);

    const { dirB, dirMoving90, dirResult } = this.basis;
    const movingDir = this.tmp.set(0, 0, 0).addScaledVector(dirB, cos).addScaledVector(dirMoving90, sin);
    if (movingDir.lengthSq() < 1e-8) movingDir.copy(dirB);
    else movingDir.normalize();

    this.orient(this.arrowB, dirB, magB);
    this.orient(this.arrowMoving, movingDir, magMoving);
    const resultSign = sin >= 0 ? 1 : -1;
    this.orient(this.arrowResult, this.tmp2.copy(dirResult).multiplyScalar(resultSign), Math.max(0.02, magResult));
    this.arrowResult.visible = Math.abs(sin) > 0.02 && product > 1e-6;

    this.placeLabel(this.labelB, dirB.clone().multiplyScalar(magB * 1.12));
    this.placeLabel(this.labelMoving, movingDir.clone().multiplyScalar(magMoving * 1.12));
    this.placeLabel(
      this.labelResult,
      dirResult.clone().multiplyScalar(resultSign * magResult * 1.12)
    );

    this.arc.geometry.dispose();
    const radius = this.length * 0.46;
    const span = Math.max(0.02, Math.abs(theta));
    this.arc.geometry = new THREE.TorusGeometry(radius, 0.0035, 8, 64, span);
    // Torus lives in XY, starts at +X and sweeps toward +Y. Map that plane onto B–moving90.
    const zAxis = new THREE.Vector3().crossVectors(dirB, dirMoving90).normalize();
    const m = new THREE.Matrix4().makeBasis(dirB, dirMoving90, zAxis);
    this.arc.quaternion.setFromRotationMatrix(m);
    if (theta < 0) this.arc.rotateZ(Math.PI);
    this.arc.position.set(0, 0, 0);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  private orient(arrow: THREE.Group, dir: THREE.Vector3, length: number): void {
    const n = dir.clone().normalize();
    arrow.quaternion.setFromUnitVectors(this.Y, n);
    arrow.scale.setScalar(length / this.length);
    arrow.position.set(0, 0, 0);
  }

  private placeLabel(label: THREE.Sprite, pos: THREE.Vector3): void {
    label.position.copy(pos);
  }
}

export function computeMotorForce(values: RigValues): number {
  const sin = Math.sin(THREE.MathUtils.degToRad(values.thetaDeg));
  return values.B * (values.I ?? 0) * values.L * sin;
}

export function computeGeneratorEmf(values: RigValues): number {
  const sin = Math.sin(THREE.MathUtils.degToRad(values.thetaDeg));
  return values.B * values.L * (values.v ?? 0) * sin;
}

export interface DiagramView {
  basis: HandBasis;
  xAxis: THREE.Vector3;
  yAxis: THREE.Vector3;
}

/** Draw a B / I(v) / F(E) diagram projected as in the default 3D view of that hand. */
export function renderDiagram(
  svg: SVGElement,
  kind: RigKind,
  thetaDeg: number,
  resultScale: number,
  view?: DiagramView
): void {
  const theta = (thetaDeg * Math.PI) / 180;
  const cx = 110;
  const cy = 78;
  const len = 58;
  const basis = view?.basis ?? {
    dirB: new THREE.Vector3(1, 0, 0),
    dirMoving90: new THREE.Vector3(0, 1, 0),
    dirResult: new THREE.Vector3(0, 0, 1),
  };
  const xAxis = view?.xAxis ?? new THREE.Vector3(1, 0, 0);
  const yAxis = view?.yAxis ?? new THREE.Vector3(0, 1, 0);

  const project = (dir: THREE.Vector3, scale = len) => {
    const px = cx + dir.dot(xAxis) * scale;
    const py = cy - dir.dot(yAxis) * scale;
    return [px, py] as const;
  };

  const arrow = (dir: THREE.Vector3, color: string, label: string, scale = len) => {
    const [tx, ty] = project(dir, scale);
    const [ox, oy] = [cx, cy];
    const ang = Math.atan2(ty - oy, tx - ox);
    const ah = 8;
    const p1x = tx - ah * Math.cos(ang - 0.4);
    const p1y = ty - ah * Math.sin(ang - 0.4);
    const p2x = tx - ah * Math.cos(ang + 0.4);
    const p2y = ty - ah * Math.sin(ang + 0.4);
    const reach = Math.hypot(tx - ox, ty - oy) || 1;
    const lx = tx + 12 * ((tx - ox) / reach);
    const ly = ty + 12 * ((ty - oy) / reach);
    return `<line x1="${ox}" y1="${oy}" x2="${tx}" y2="${ty}" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>
      <polygon points="${tx},${ty} ${p1x},${p1y} ${p2x},${p2y}" fill="${color}"/>
      <text x="${lx}" y="${ly}" fill="${color}" font-size="16" font-family="Times New Roman, serif" font-weight="700" text-anchor="middle" dominant-baseline="middle">${label}</text>`;
  };

  const movingDir = basis.dirB.clone().multiplyScalar(Math.cos(theta)).addScaledVector(basis.dirMoving90, Math.sin(theta));
  if (movingDir.lengthSq() < 1e-8) movingDir.copy(basis.dirB);
  else movingDir.normalize();

  const movingLabel = kind === "motor" ? "I" : "v";
  const resultLabel = kind === "motor" ? "F" : "E";
  const movingColor = kind === "motor" ? HEX_I : HEX_F;
  const resultColor = kind === "motor" ? HEX_F : HEX_I;

  const b = arrow(basis.dirB, HEX_B, "B");
  const moving = arrow(movingDir, movingColor, movingLabel);
  const resultSign = Math.sin(theta) >= 0 ? 1 : -1;

  const mid = basis.dirB
    .clone()
    .multiplyScalar(Math.cos(theta / 2))
    .addScaledVector(basis.dirMoving90, Math.sin(theta / 2));
  if (mid.lengthSq() > 1e-8) mid.normalize();
  const [ax, ay] = project(mid, 28);
  let arcPath = "";
  const steps = Math.max(8, Math.round(Math.abs(thetaDeg) / 6));
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (theta * i) / steps;
    const d = basis.dirB.clone().multiplyScalar(Math.cos(t)).addScaledVector(basis.dirMoving90, Math.sin(t));
    if (d.lengthSq() > 1e-8) d.normalize();
    const [px, py] = project(d, 28);
    pts.push(`${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`);
  }
  arcPath = `<path d="${pts.join(" ")}" fill="none" stroke="#445" stroke-width="1.2"/>`;
  const thetaLabel = `<text x="${ax}" y="${ay}" fill="#445" font-size="12" text-anchor="middle">θ</text>`;

  const resultArrow =
    Math.abs(Math.sin(theta)) < 0.02
      ? ""
      : arrow(basis.dirResult.clone().multiplyScalar(resultSign), resultColor, resultLabel, Math.max(0.08, resultScale) * len);

  svg.innerHTML = `
    <rect x="0" y="0" width="220" height="140" rx="8" fill="#f7f8fb"/>
    ${b}${moving}${resultArrow}${arcPath}${thetaLabel}
  `;
}
