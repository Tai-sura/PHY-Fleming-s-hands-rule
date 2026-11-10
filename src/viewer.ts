import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FormulaRig, makeHandBasis, type DiagramView, type RigKind, type RigValues } from "./formulaRig";

export type VectorKey = "F" | "B" | "I";
export type ViewPreset = "front" | "side" | "top" | "back";
export type AlignMode = "toCamera" | "vertical" | "horizontal";

export interface CameraState {
  azimuth: number;
  polar: number;
  radius: number;
  target: THREE.Vector3Tuple;
}

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  background: number;
  modelUrl: string;
  rigKind: RigKind;
  defaultAzimuth: number;
  defaultPolar: number;
}

const SKIN = new THREE.Color(0xffd8bd);
const WHITE = new THREE.Color(0xffffff);
const loader = new GLTFLoader();

export class HandViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly rig: FormulaRig;
  readonly modelUrl: string;
  readonly defaultAzimuth: number;
  readonly defaultPolar: number;

  private readonly root = new THREE.Group();
  private readonly pose = new THREE.Group();
  private model: THREE.Group | null = null;
  private readonly vectorGroups: Record<VectorKey, THREE.Object3D[]> = { F: [], B: [], I: [] };
  private readonly handMeshes: THREE.Mesh[] = [];
  private readonly skinOriginal = new Map<THREE.Mesh, THREE.Color>();
  private raf = 0;
  private disposed = false;
  private skinEnabled = true;
  private skinStrength = 0.85;
  private defaultRadius = 1.2;
  private defaultTarget: THREE.Vector3Tuple = [0, 0.15, 0];
  private userMovedCamera = false;

  onCameraChange: ((state: CameraState) => void) | null = null;
  private suppressCameraEvent = false;

  constructor(options: ViewerOptions) {
    this.modelUrl = options.modelUrl;
    this.defaultAzimuth = options.defaultAzimuth;
    this.defaultPolar = options.defaultPolar;

    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 50);
    this.scene.background = new THREE.Color(options.background);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotate = false;
    this.controls.autoRotateSpeed = 1.4;
    this.controls.minDistance = 0.15;
    this.controls.maxDistance = 8;
    this.controls.addEventListener("change", () => {
      if (!this.suppressCameraEvent) {
        this.userMovedCamera = true;
        this.onCameraChange?.(this.getCameraState());
      }
    });

    this.pose.name = "pose";
    this.root.add(this.pose);
    this.scene.add(this.root);
    this.rig = new FormulaRig(options.rigKind);
    this.rig.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = false;
        obj.receiveShadow = false;
      }
    });
    this.scene.add(this.rig.group);
    this.addLights();
    this.resize();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  async load(url = this.modelUrl): Promise<void> {
    if (this.model) {
      this.pose.remove(this.model);
      this.model.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry?.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const mat of mats) mat.dispose();
        }
      });
      this.model = null;
    }
    this.vectorGroups.F = [];
    this.vectorGroups.B = [];
    this.vectorGroups.I = [];
    this.handMeshes.length = 0;
    this.skinOriginal.clear();

    const gltf = await loader.loadAsync(url);
    this.model = gltf.scene;
    this.model.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        const unique = materials.map((m) => m.clone());
        obj.material = Array.isArray(obj.material) ? unique : unique[0];
      }
    });
    this.classify(this.model);
    this.pose.quaternion.identity();
    this.pose.position.set(0, 0, 0);
    this.model.position.set(0, 0, 0);
    this.pose.add(this.model);
    this.model.updateWorldMatrix(true, true);
    const center = new THREE.Box3().setFromObject(this.model).getCenter(new THREE.Vector3());
    this.pose.position.copy(center);
    this.model.position.copy(center).negate();
    this.pose.add(this.rig.group);
    this.alignRigToHand();
    this.frameModel();
    this.applySkin();
  }

  /** Default-view axes plus the hand-aligned formula basis, for the 2D diagram. */
  getDiagramView(): DiagramView {
    const offset = new THREE.Vector3().setFromSpherical(
      new THREE.Spherical(1, this.defaultPolar, this.defaultAzimuth)
    );
    const zAxis = offset.normalize();
    const xAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), zAxis).normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    return { basis: this.rig.getBasis(), xAxis, yAxis };
  }

  setVectorVisible(key: VectorKey, visible: boolean): void {
    for (const obj of this.vectorGroups[key]) obj.visible = visible;
  }

  setSkinTint(enabled: boolean, strength = this.skinStrength): void {
    this.skinEnabled = enabled;
    this.skinStrength = strength;
    this.applySkin();
  }

  setAutoRotate(on: boolean): void {
    this.controls.autoRotate = on;
  }

  isAutoRotate(): boolean {
    return this.controls.autoRotate;
  }

  setRigVisible(visible: boolean): void {
    this.rig.setVisible(visible);
  }

  updateRig(values: RigValues): void {
    this.rig.update(values);
  }

  getCameraState(): CameraState {
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    return {
      azimuth: spherical.theta,
      polar: spherical.phi,
      radius: spherical.radius,
      target: this.controls.target.toArray(),
    };
  }

  setCameraState(state: CameraState): void {
    this.suppressCameraEvent = true;
    this.controls.target.fromArray(state.target);
    const spherical = new THREE.Spherical(state.radius, state.polar, state.azimuth);
    const offset = new THREE.Vector3().setFromSpherical(spherical);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
    this.suppressCameraEvent = false;
  }

  resetCamera(): void {
    this.suppressCameraEvent = true;
    this.controls.target.fromArray(this.defaultTarget);
    const spherical = new THREE.Spherical(this.defaultRadius, this.defaultPolar, this.defaultAzimuth);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    this.controls.update();
    this.suppressCameraEvent = false;
    this.userMovedCamera = false;
  }

  resetPose(): void {
    this.pose.quaternion.identity();
  }

  setViewPreset(name: ViewPreset): void {
    let azimuth = this.defaultAzimuth;
    let polar = this.defaultPolar;
    if (name === "side") {
      azimuth = this.defaultAzimuth - Math.PI / 2;
      polar = Math.PI / 2;
    } else if (name === "top") {
      polar = 0.22;
    } else if (name === "back") {
      azimuth = this.defaultAzimuth + Math.PI;
    }
    this.setCameraState({
      azimuth,
      polar,
      radius: this.defaultRadius,
      target: [...this.defaultTarget],
    });
  }

  /** Rotate the hand around its current F, B or I world axis. */
  rotateAroundAxis(key: VectorKey, degrees: number): void {
    const axis = this.arrowDirection(key);
    if (!axis) return;
    const q = new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees));
    this.pose.quaternion.premultiply(q);
  }

  /**
   * Rotate the hand so the named vector points at the camera,
   * straight up on screen, or to the right on screen.
   */
  alignVector(key: VectorKey, mode: AlignMode): void {
    const current = this.arrowDirection(key);
    if (!current) return;
    const target = this.screenAxis(mode);
    if (current.dot(target) > 0.9995) return;
    if (current.dot(target) < -0.9995) {
      const helper = Math.abs(current.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const orth = new THREE.Vector3().crossVectors(current, helper).normalize();
      this.pose.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(orth, Math.PI));
      return;
    }
    this.pose.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(current, target));
  }

  private screenAxis(mode: AlignMode): THREE.Vector3 {
    const zAxis = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    if (mode === "toCamera") return zAxis;
    const xAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), zAxis);
    if (xAxis.lengthSq() < 1e-8) xAxis.set(1, 0, 0);
    else xAxis.normalize();
    if (mode === "horizontal") return xAxis;
    return new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const parent = canvas.parentElement;
    const width = parent?.clientWidth || canvas.clientWidth || 1;
    const height = parent?.clientHeight || canvas.clientHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    if (this.model) this.frameModel(!this.userMovedCamera);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.renderer.dispose();
  }

  private classify(root: THREE.Object3D): void {
    root.traverse((obj) => {
      const name = obj.name || "";
      const match = /^(letter|arrow)-([FBI])/.exec(name);
      if (match) {
        const key = match[2] as VectorKey;
        this.vectorGroups[key].push(obj);
      }
      if (name === "hand" || name.startsWith("mesh-hand")) {
        obj.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            this.handMeshes.push(child);
            const mat = child.material;
            if (mat instanceof THREE.MeshStandardMaterial) {
              this.skinOriginal.set(child, mat.color.clone());
              mat.metalness = 0;
              if (mat.roughness < 0.3) mat.roughness = 0.48;
              mat.vertexColors = Boolean(child.geometry.getAttribute("color"));
            }
          }
        });
      }
    });
  }

  private arrowDirection(key: VectorKey): THREE.Vector3 | null {
    if (!this.model) return null;
    const arrow = this.model.getObjectByName(`arrow-${key}`);
    if (!arrow) return null;
    let head: THREE.Vector3 | null = null;
    let shaft: THREE.Vector3 | null = null;
    arrow.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const center = new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
      if (obj.name.includes("head")) head = center;
      else if (obj.name.includes("shaft")) shaft = center;
    });
    if (!head || !shaft) return null;
    const dir = (head as THREE.Vector3).sub(shaft as THREE.Vector3);
    if (dir.lengthSq() < 1e-10) return null;
    return dir.normalize();
  }

  private alignRigToHand(): void {
    if (!this.model) return;
    const dirB = this.arrowDirection("B");
    if (!dirB) {
      this.rig.placeBeside(this.model, this.rig.kind === "motor" ? "left" : "right");
      return;
    }
    // Motor: I is current, F is the force. Generator: thumb F is motion v, middle I is E.
    const dirMoving = this.arrowDirection(this.rig.kind === "motor" ? "I" : "F");
    const dirResult = this.arrowDirection(this.rig.kind === "motor" ? "F" : "I");
    if (dirMoving && dirResult) {
      this.rig.setBasis(makeHandBasis(dirB, dirMoving, dirResult));
    }
    this.rig.placeBeside(this.model, this.rig.kind === "motor" ? "left" : "right");
  }

  private applySkin(): void {
    const mix = this.skinEnabled ? this.skinStrength : 0;
    const tint = WHITE.clone().lerp(SKIN, mix);
    for (const mesh of this.handMeshes) {
      const mat = mesh.material;
      if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
      const base = this.skinOriginal.get(mesh) ?? WHITE;
      mat.color.copy(base).multiply(tint);
      mat.metalness = 0;
      mat.needsUpdate = true;
    }
  }

  private frameModel(applyCamera = true): void {
    if (!this.model) return;
    this.pose.updateWorldMatrix(true, true);
    const content = new THREE.Box3().setFromObject(this.model);
    if (content.isEmpty()) return;
    const hand = this.model.getObjectByName("hand");
    const focus = (hand ? new THREE.Box3().setFromObject(hand) : content).getCenter(new THREE.Vector3());
    // Fit every baked arrow and letter around the palm, not a sphere that
    // includes the side formula rig (that had zoomed the hands too small).
    let maxX = 0;
    let maxY = 0;
    let maxZ = 0;
    for (const x of [content.min.x, content.max.x]) {
      for (const y of [content.min.y, content.max.y]) {
        for (const z of [content.min.z, content.max.z]) {
          maxX = Math.max(maxX, Math.abs(x - focus.x));
          maxY = Math.max(maxY, Math.abs(y - focus.y));
          maxZ = Math.max(maxZ, Math.abs(z - focus.z));
        }
      }
    }
    const aspect = Math.max(this.camera.aspect, 0.15);
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const fitH = maxY / Math.tan(halfFov);
    const fitW = maxX / Math.tan(halfFov) / aspect;
    this.defaultTarget = [focus.x, focus.y, focus.z];
    this.defaultRadius = Math.max(fitH, fitW) * 1.2 + maxZ * 0.2;
    const span = Math.max(maxX, maxY, maxZ);
    this.controls.minDistance = span * 0.6;
    this.controls.maxDistance = span * 16;
    if (applyCamera) this.resetCamera();
  }

  private addLights(): void {
    const hemi = new THREE.HemisphereLight(0xfff6ee, 0x8a8ea0, 1.05);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff3e8, 1.35);
    key.position.set(0.6, 1.4, 0.9);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far = 8;
    key.shadow.camera.left = -1.2;
    key.shadow.camera.right = 1.2;
    key.shadow.camera.top = 1.2;
    key.shadow.camera.bottom = -1.2;
    key.shadow.bias = -0.0008;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xdfe9ff, 0.45);
    fill.position.set(-0.8, 0.4, -0.5);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, 0.25);
    rim.position.set(0.2, 0.8, -1.0);
    this.scene.add(rim);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(2.4, 48),
      new THREE.ShadowMaterial({ opacity: 0.28 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  private loop(): void {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
