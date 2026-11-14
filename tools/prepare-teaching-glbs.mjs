/**
 * Prepare confirmed arrowed left/right GLBs for the local teaching page.
 * Renames the hand mesh so the viewer will not overlay procedural nails,
 * then applies meshopt compression for faster local loads.
 */
import { mkdir, copyFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, weld, meshopt } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SRC = {
  left: join(ROOT, "research/hands-03-2026-11-14/preview/left-with-arrows.glb"),
  right: join(ROOT, "research/hands-03-2026-11-14/preview/right-with-arrows.glb"),
};
const OUT_DIR = join(ROOT, "public/models");

function markHandPreview(doc) {
  const visit = (node) => {
    if (node.getMesh()) {
      node.setName("mesh-hand-preview");
      node.getMesh().setName("mesh-hand-preview");
    }
    for (const child of node.listChildren()) visit(child);
  };
  for (const node of doc.getRoot().listNodes()) {
    if (node.getName() === "hand") visit(node);
  }
}


// Blender's glTF exporter maps (x, y, z) -> (x, z, -y), so thumbs that were +Y
// in the confirmed preview become -Z in three.js. Rotate Rx(+90°) to restore
// the preview orientation (F ≈ +Y, B ≈ +Z) before teaching-page load.
function correctBlenderExportAxes(doc) {
  const q = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]; // Rx(+90°), xy zw
  const qx = q[0], qw = q[3];
  const scene = doc.getRoot().listScenes()[0];
  for (const node of scene.listChildren()) {
    const [tx, ty, tz] = node.getTranslation();
    // (x, y, z) -> (x, -z, y)
    node.setTranslation([tx, -tz, ty]);
    const [rx, ry, rz, rw] = node.getRotation();
    // q * r
    node.setRotation([
      qw * rx + qx * rw,
      qw * ry - qx * rz,
      qw * rz + qx * ry,
      qw * rw - qx * rx,
    ]);
  }
}

async function prepare(side, srcPath, destName) {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      "meshopt.decoder": MeshoptDecoder,
      "meshopt.encoder": MeshoptEncoder,
    });
  const doc = await io.read(srcPath);
  markHandPreview(doc);
  correctBlenderExportAxes(doc);
  await doc.transform(dedup(), weld(), prune(), meshopt({ encoder: MeshoptEncoder, level: "medium" }));
  const dest = join(OUT_DIR, destName);
  await io.write(dest, doc);
  const [inStat, outStat] = await Promise.all([stat(srcPath), stat(dest)]);
  console.log(
    `${side}: ${(inStat.size / 1e6).toFixed(2)} MB -> ${(outStat.size / 1e6).toFixed(2)} MB (${dest})`
  );
  // verify names
  const check = await io.read(dest);
  const names = check.getRoot().listNodes().map((n) => n.getName());
  const needed = ["hand", "mesh-hand-preview", "arrow-F", "arrow-B", "arrow-I", "letter-F", "letter-B", "letter-I"];
  const missing = needed.filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`${side} missing nodes: ${missing.join(", ")} (have ${names.join(", ")})`);
  const ext = check.getRoot().listExtensionsUsed().map((e) => e.extensionName);
  console.log(`  nodes ok; extensions: ${ext.join(", ") || "(none)"}`);
}

await mkdir(OUT_DIR, { recursive: true });
await prepare("left", SRC.left, "fleming-left.glb");
await prepare("right", SRC.right, "fleming-right.glb");
