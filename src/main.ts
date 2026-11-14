import {
  computeGeneratorEmf,
  computeMotorForce,
  renderDiagram,
  type RigValues,
} from "./formulaRig";
import { HandViewer, type AlignMode, type CameraState, type VectorKey, type ViewPreset } from "./viewer";

const LEFT_MODEL = `${import.meta.env.BASE_URL}models/fleming-left.glb`;
const RIGHT_MODEL = `${import.meta.env.BASE_URL}models/fleming-right.glb`;

interface PanelState {
  side: "left" | "right";
  viewer: HandViewer;
  root: HTMLElement;
  values: RigValues;
  objectUrls: string[];
}

function fmt(value: number, unit: string, digits = 2): string {
  const abs = Math.abs(value);
  const d = abs >= 10 ? 2 : abs >= 1 ? 2 : abs >= 0.1 ? 3 : 3;
  return `${value.toFixed(Math.max(digits, d))} ${unit}`;
}

function readValues(card: HTMLElement, kind: "motor" | "generator"): RigValues {
  const num = (name: string, fallback: number) => {
    const input = card.querySelector<HTMLInputElement>(`[data-param="${name}"]`);
    return input ? Number(input.value) : fallback;
  };
  if (kind === "motor") {
    return { B: num("B", 1), I: num("I", 1), L: num("L", 0.1), thetaDeg: num("theta", 90) };
  }
  return { B: num("B", 1), L: num("L", 0.1), v: num("v", 1), thetaDeg: num("theta", 90) };
}

function refreshFormula(panel: PanelState): void {
  const card = panel.root.querySelector<HTMLElement>(".formula-card")!;
  const kind = card.dataset.formula === "generator" ? "generator" : "motor";
  panel.values = readValues(card, kind);
  const result = kind === "motor" ? computeMotorForce(panel.values) : computeGeneratorEmf(panel.values);
  const resultEl = card.querySelector<HTMLElement>("[data-result]")!;
  resultEl.textContent = result.toFixed(3);
  const setVal = (key: string, text: string) => {
    const el = card.querySelector(`[data-val="${key}"]`);
    if (el) el.textContent = text;
  };
  setVal("B", fmt(panel.values.B, "T"));
  setVal("I", fmt(panel.values.I ?? 0, "A"));
  setVal("L", fmt(panel.values.L, "m"));
  setVal("v", fmt(panel.values.v ?? 0, "m/s"));
  setVal("theta", `${Math.round(panel.values.thetaDeg)}°`);
  const note = card.querySelector<HTMLElement>("[data-align-note]");
  if (note) note.hidden = Math.round(panel.values.thetaDeg) !== 90;
  const ref = kind === "motor" ? 0.1 : 0.1;
  renderDiagram(
    card.querySelector("[data-diagram]")!,
    kind,
    panel.values.thetaDeg,
    Math.min(1.3, Math.abs(result) / ref),
    panel.viewer.getDiagramView()
  );
  panel.viewer.updateRig(panel.values);
}

function bindFormula(panel: PanelState): void {
  const card = panel.root.querySelector(".formula-card")!;
  card.querySelectorAll("input[type=range]").forEach((input) => {
    input.addEventListener("input", () => refreshFormula(panel));
  });
  card.querySelectorAll<HTMLButtonElement>("[data-snap]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = card.querySelector<HTMLInputElement>("[data-param=theta]");
      if (!input) return;
      input.value = btn.dataset.snap ?? "90";
      refreshFormula(panel);
    });
  });
  refreshFormula(panel);
}

function bindPanel(panel: PanelState, defaultUrl: string): void {
  const root = panel.root;

  root.querySelectorAll<HTMLButtonElement>("[data-vector]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.vector as VectorKey;
      const visible = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", String(visible));
      panel.viewer.setVectorVisible(key, visible);
    });
  });

  const rotateBtn = root.querySelector<HTMLButtonElement>("[data-action=rotate]")!;
  rotateBtn.addEventListener("click", () => {
    const on = !panel.viewer.isAutoRotate();
    setRotate(panel, on);
    if (syncRotate) setRotate(otherOf(panel), on);
  });

  root.querySelector("[data-action=reset-camera]")!.addEventListener("click", () => {
    panel.viewer.resetCamera();
    if (syncRotate) otherOf(panel).viewer.setCameraState(panel.viewer.getCameraState());
  });

  root.querySelector("[data-action=reset-pose]")!.addEventListener("click", () => {
    panel.viewer.resetPose();
  });

  root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      panel.viewer.setViewPreset(btn.dataset.view as ViewPreset);
      if (syncRotate) otherOf(panel).viewer.setCameraState(panel.viewer.getCameraState());
    });
  });

  root.querySelectorAll<HTMLButtonElement>("[data-spin]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.spin as VectorKey;
      const deg = Number(btn.dataset.deg);
      panel.viewer.rotateAroundAxis(key, deg);
    });
  });

  root.querySelectorAll<HTMLButtonElement>("[data-align]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.axis as VectorKey;
      const mode = btn.dataset.align as AlignMode;
      panel.viewer.alignVector(key, mode);
    });
  });

  root.querySelector("[data-action=reload]")!.addEventListener("click", async () => {
    setLoading(root, true);
    await panel.viewer.load(defaultUrl);
    applyGlobalSkin();
    refreshFormula(panel);
    setLoading(root, false);
  });

  bindFormula(panel);
}

function setRotate(panel: PanelState, on: boolean): void {
  panel.viewer.setAutoRotate(on);
  const btn = panel.root.querySelector<HTMLButtonElement>("[data-action=rotate]")!;
  btn.setAttribute("aria-pressed", String(on));
  btn.textContent = on ? "停止旋轉" : "開始旋轉";
}

function setLoading(root: HTMLElement, loading: boolean): void {
  const el = root.querySelector<HTMLElement>("[data-loading]");
  if (el) el.hidden = !loading;
}

let left!: PanelState;
let right!: PanelState;
let syncRotate = false;
let syncing = false;

function otherOf(panel: PanelState): PanelState {
  return panel === left ? right : left;
}

function onCameraChange(source: PanelState, state: CameraState): void {
  if (!syncRotate || syncing) return;
  syncing = true;
  otherOf(source).viewer.setCameraState(state);
  syncing = false;
}

function applyGlobalSkin(): void {
  const enabled = document.querySelector<HTMLInputElement>("#skin-tint")!.checked;
  const strength = Number(document.querySelector<HTMLInputElement>("#skin-strength")!.value) / 100;
  left.viewer.setSkinTint(enabled, strength);
  right.viewer.setSkinTint(enabled, strength);
}

function applyRigVisibility(): void {
  const visible = document.querySelector<HTMLInputElement>("#show-rig")!.checked;
  left.viewer.setRigVisible(visible);
  right.viewer.setRigVisible(visible);
}

async function boot(): Promise<void> {
  const leftRoot = document.getElementById("left-panel")!;
  const rightRoot = document.getElementById("right-panel")!;

  const leftViewer = new HandViewer({
    canvas: document.getElementById("left-canvas") as HTMLCanvasElement,
    background: 0xe8f0fe,
    modelUrl: LEFT_MODEL,
    rigKind: "motor",
    defaultAzimuth: Math.PI + 0.70,
    defaultPolar: 1.18,
  });
  const rightViewer = new HandViewer({
    canvas: document.getElementById("right-canvas") as HTMLCanvasElement,
    background: 0xfef0e8,
    modelUrl: RIGHT_MODEL,
    rigKind: "generator",
    defaultAzimuth: Math.PI - 0.70,
    defaultPolar: 1.18,
  });

  left = {
    side: "left",
    viewer: leftViewer,
    root: leftRoot,
    values: { B: 1, I: 1, L: 0.1, thetaDeg: 90 },
    objectUrls: [],
  };
  right = {
    side: "right",
    viewer: rightViewer,
    root: rightRoot,
    values: { B: 1, L: 0.1, v: 1, thetaDeg: 90 },
    objectUrls: [],
  };

  left.viewer.onCameraChange = (state) => onCameraChange(left, state);
  right.viewer.onCameraChange = (state) => onCameraChange(right, state);

  bindPanel(left, LEFT_MODEL);
  bindPanel(right, RIGHT_MODEL);

  document.querySelector("#sync-rotate")!.addEventListener("change", (ev) => {
    syncRotate = (ev.target as HTMLInputElement).checked;
    if (syncRotate) {
      right.viewer.setCameraState(left.viewer.getCameraState());
      setRotate(right, left.viewer.isAutoRotate());
    }
  });
  document.querySelector("#skin-tint")!.addEventListener("change", applyGlobalSkin);
  document.querySelector("#skin-strength")!.addEventListener("input", applyGlobalSkin);
  document.querySelector("#show-rig")!.addEventListener("change", applyRigVisibility);

  const ro = new ResizeObserver(() => {
    left.viewer.resize();
    right.viewer.resize();
  });
  ro.observe(leftRoot.querySelector(".viewport")!);
  ro.observe(rightRoot.querySelector(".viewport")!);

  setLoading(leftRoot, true);
  setLoading(rightRoot, true);
  try {
    await Promise.all([left.viewer.load(LEFT_MODEL), right.viewer.load(RIGHT_MODEL)]);
    applyGlobalSkin();
    applyRigVisibility();
    refreshFormula(left);
    refreshFormula(right);
  } catch (err) {
    console.error(err);
    leftRoot.querySelector("[data-loading]")!.textContent = "模型載入失敗";
    rightRoot.querySelector("[data-loading]")!.textContent = "模型載入失敗";
    return;
  }
  setLoading(leftRoot, false);
  setLoading(rightRoot, false);
}

void boot();
