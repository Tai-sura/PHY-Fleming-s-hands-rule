#!/usr/bin/env node
/**
 * Optimize the Fleming left/right hand GLBs:
 *  - Name letter / arrow / hand groups so the teaching app can toggle F/B/I
 *  - Convert spec-gloss to metal-rough
 *  - Flatten solid-color letter/arrow textures to factors
 *  - Dielectric metalness, sensible roughness
 *  - Resize hand albedos and compress to JPEG/WebP
 *  - Dedup, prune, weld, compact
 */
import { mkdir, writeFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import sharp from "sharp";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRMaterialsPBRSpecularGlossiness } from "@gltf-transform/extensions";
import {
  metalRough,
  dedup,
  prune,
  textureCompress,
  weld,
  center,
  TextureResizeFilter,
  listTextureSlots,
} from "@gltf-transform/functions";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SRC = {
  left: join(ROOT, "models/fleming-left.glb"),
  right: join(ROOT, "models/fleming-right.glb"),
};
const OUT_DIR = join(ROOT, "public/models");
const EVIDENCE = join(ROOT, "evidence");

const COLORS = {
  F: { srgb: [63, 72, 204], name: "F" },
  B: { srgb: [14, 209, 69], name: "B" },
  I: { srgb: [250, 46, 86], name: "I" },
};

function srgbToLinear(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function classifyColor(rgb) {
  let best = null;
  let bestD = Infinity;
  for (const [key, { srgb }] of Object.entries(COLORS)) {
    const d =
      (rgb[0] - srgb[0]) ** 2 +
      (rgb[1] - srgb[1]) ** 2 +
      (rgb[2] - srgb[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = key;
    }
  }
  return bestD < 80 ** 2 ? best : null;
}

async function sampleTextureRGB(texture) {
  if (!texture) return null;
  const image = texture.getImage();
  if (!image) return null;
  const size = texture.getSize() || [1, 1];
  try {
    const { data, info } = await sharp(Buffer.from(image))
      .ensureAlpha()
      .resize(1, 1, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { rgb: [data[0], data[1], data[2]], alpha: data[3], width: size[0], height: size[1], channels: info.channels };
  } catch (err) {
    console.warn("sample failed", err.message);
    return null;
  }
}

function getDiffuseTexture(material) {
  const ext = material.getExtension(KHRMaterialsPBRSpecularGlossiness.EXTENSION_NAME);
  if (ext && ext.getDiffuseTexture()) return ext.getDiffuseTexture();
  return material.getBaseColorTexture();
}

function vertexCount(mesh) {
  let n = 0;
  for (const prim of mesh.listPrimitives()) {
    n += prim.getAttribute("POSITION")?.getCount() ?? 0;
  }
  return n;
}

function collectDescendantMeshes(node, out = []) {
  const mesh = node.getMesh();
  if (mesh) out.push({ node, mesh });
  for (const child of node.listChildren()) collectDescendantMeshes(child, out);
  return out;
}

async function classifyAndName(document, label) {
  const rootNode = document
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === "root");
  if (!rootNode) throw new Error(`${label}: no root node`);

  const report = { label, letters: {}, arrows: {}, hand: [], unnamed: [] };

  for (const child of rootNode.listChildren()) {
    const items = collectDescendantMeshes(child);
    const classes = [];
    for (const item of items) {
      const mat = item.mesh.listPrimitives()[0]?.getMaterial();
      const tex = mat ? getDiffuseTexture(mat) : null;
      const sample = await sampleTextureRGB(tex);
      const verts = vertexCount(item.mesh);
      const size = sample ? Math.max(sample.width, sample.height) : 0;
      let kind;
      let letter = null;
      if (size >= 64 || verts >= 2000) {
        kind = "hand";
      } else {
        letter = sample ? classifyColor(sample.rgb) : null;
        kind = items.length === 1 ? "letter" : "arrow";
      }
      classes.push({ ...item, kind, letter, verts, sample });
    }

    const kinds = new Set(classes.map((c) => c.kind));
    if (kinds.size === 1 && kinds.has("letter") && classes[0].letter) {
      const L = classes[0].letter;
      child.setName(`letter-${L}`);
      classes[0].node.setName(`mesh-letter-${L}`);
      if (classes[0].mesh) classes[0].mesh.setName(`mesh-letter-${L}`);
      report.letters[L] = {
        node: child.getName(),
        verts: classes[0].verts,
        color: classes[0].sample?.rgb,
      };
    } else if (kinds.has("hand") && kinds.has("arrow")) {
      // mixed group: hand + three arrow pairs. Name subgroups.
      child.setName("model-assembly");
      // Among this child's children, classify each subgroup
      for (const sub of child.listChildren()) {
        const subItems = collectDescendantMeshes(sub);
        const subClasses = [];
        for (const item of subItems) {
          const mat = item.mesh.listPrimitives()[0]?.getMaterial();
          const tex = mat ? getDiffuseTexture(mat) : null;
          const sample = await sampleTextureRGB(tex);
          const verts = vertexCount(item.mesh);
          const size = sample ? Math.max(sample.width, sample.height) : 0;
          if (size >= 64 || verts >= 2000) {
            subClasses.push({ ...item, kind: "hand", sample, verts });
          } else {
            const letter = sample ? classifyColor(sample.rgb) : null;
            subClasses.push({ ...item, kind: "arrow", letter, sample, verts });
          }
        }
        const subKinds = new Set(subClasses.map((c) => c.kind));
        if (subKinds.size === 1 && subKinds.has("hand")) {
          sub.setName("hand");
          subClasses.forEach((c, i) => {
            c.node.setName(`mesh-hand-${i}`);
            c.mesh.setName(`mesh-hand-${i}`);
            report.hand.push({ node: c.node.getName(), verts: c.verts });
          });
        } else if (subKinds.size === 1 && subKinds.has("arrow")) {
          const L = subClasses.find((c) => c.letter)?.letter ?? "X";
          sub.setName(`arrow-${L}`);
          subClasses.forEach((c, i) => {
            const part = c.verts >= 300 ? "shaft" : "head";
            c.node.setName(`mesh-arrow-${L}-${part}`);
            c.mesh.setName(`mesh-arrow-${L}-${part}`);
          });
          report.arrows[L] = {
            node: sub.getName(),
            parts: subClasses.map((c) => ({ verts: c.verts, color: c.sample?.rgb })),
          };
        } else {
          report.unnamed.push({
            name: sub.getName(),
            kinds: [...subKinds],
            count: subClasses.length,
          });
        }
      }
    } else if (kinds.size === 1 && kinds.has("hand")) {
      child.setName("hand");
      classes.forEach((c, i) => {
        c.node.setName(`mesh-hand-${i}`);
        c.mesh.setName(`mesh-hand-${i}`);
        report.hand.push({ node: c.node.getName(), verts: c.verts });
      });
    } else {
      report.unnamed.push({
        name: child.getName(),
        kinds: [...kinds],
        count: classes.length,
      });
    }
  }

  return report;
}


async function stripUnusedAlpha(document) {
  const notes = [];
  for (const texture of document.getRoot().listTextures()) {
    const image = texture.getImage();
    if (!image) continue;
    const pipeline = sharp(Buffer.from(image)).ensureAlpha();
    const { data, info } = await pipeline
      .clone()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let minA = 255;
    let maxA = 0;
    for (let i = 3; i < data.length; i += info.channels) {
      const a = data[i];
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
    }
    const opaque = minA === 255 && maxA === 255;
    if (opaque || info.channels === 3) {
      const out = await sharp(Buffer.from(image))
        .removeAlpha()
        .png({ compressionLevel: 9 })
        .toBuffer();
      texture.setImage(out);
      texture.setMimeType("image/png");
      notes.push({
        name: texture.getName(),
        action: "strip-alpha",
        minA,
        maxA,
        before: image.byteLength,
        after: out.byteLength,
      });
    } else {
      notes.push({ name: texture.getName(), action: "keep-alpha", minA, maxA });
    }
  }
  return notes;
}


function disposeOrphansAndExtensions(document) {
  for (const material of document.getRoot().listMaterials()) {
    material.getExtension("KHR_materials_specular")?.dispose();
    material.getExtension("KHR_materials_ior")?.dispose();
    material.setExtension("KHR_materials_specular", null);
    material.setExtension("KHR_materials_ior", null);
  }
  let disposed = 0;
  for (const texture of document.getRoot().listTextures()) {
    const slots = listTextureSlots(texture);
    if (!slots.includes("baseColorTexture")) {
      texture.dispose();
      disposed += 1;
    }
  }
  return disposed;
}

async function flattenSolidColorMaterials(document) {
  const flattened = [];
  for (const material of document.getRoot().listMaterials()) {
    const tex = material.getBaseColorTexture();
    if (!tex) continue;
    const size = tex.getSize() || [0, 0];
    if (Math.max(size[0], size[1]) > 16) continue;
    const sample = await sampleTextureRGB(tex);
    if (!sample) continue;
    const factor = [
      srgbToLinear(sample.rgb[0]),
      srgbToLinear(sample.rgb[1]),
      srgbToLinear(sample.rgb[2]),
      (sample.alpha ?? 255) / 255,
    ];
    material.setBaseColorFactor(factor);
    material.setBaseColorTexture(null);
    material.setMetallicRoughnessTexture(null);
    material.setAlphaMode("OPAQUE");
    flattened.push({
      name: material.getName(),
      srgb: sample.rgb,
      factor,
    });
  }
  return flattened;
}

function retuneMaterials(document, handMeshNames) {
  const handNames = new Set(handMeshNames);
  const handMaterials = new Set();
  for (const mesh of document.getRoot().listMeshes()) {
    if (handNames.has(mesh.getName()) || mesh.getName().startsWith("mesh-hand")) {
      for (const prim of mesh.listPrimitives()) {
        const mat = prim.getMaterial();
        if (mat) handMaterials.add(mat);
      }
    }
  }
  const notes = [];
  for (const material of document.getRoot().listMaterials()) {
    const isHand = handMaterials.has(material);
    material.setMetallicFactor(0);
    if (!material.getMetallicRoughnessTexture()) {
      material.setRoughnessFactor(isHand ? 0.52 : 0.38);
    } else {
      // Keep roughness from texture; force metalness channel unused via factor 0
      material.setMetallicFactor(0);
      material.setRoughnessFactor(1);
    }
    material.setDoubleSided(true);
    notes.push({
      name: material.getName(),
      role: isHand ? "hand" : "vector",
      metallic: material.getMetallicFactor(),
      roughness: material.getRoughnessFactor(),
    });
  }
  return notes;
}

async function optimizeOne(side, srcPath) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ sharp });
  const started = Date.now();
  const srcStat = await stat(srcPath);
  const document = await io.read(srcPath);

  const naming = await classifyAndName(document, side);
  console.log(`\n[${side}] naming`, JSON.stringify(naming, null, 2));

  await document.transform(metalRough());
  const flattened = await flattenSolidColorMaterials(document);

  // metalRough() may attach KHR_materials_specular / IOR (ior=1000) to
  // preserve the Windows exporter's odd metal+spec-gloss combo. Drop them
  // so the hands render as dielectrics and unused specular maps can be pruned.
  for (const material of document.getRoot().listMaterials()) {
    material.setExtension("KHR_materials_specular", null);
    material.setExtension("KHR_materials_ior", null);
    material.setAlphaMode("OPAQUE");
    material.setMetallicFactor(0);
    material.setMetallicRoughnessTexture(null);
  }

  const stripped = await stripUnusedAlpha(document);
  const materialNotes = retuneMaterials(document, naming.hand.map((h) => h.node));

  await document.transform(
    dedup(),
    prune(),
    weld(),
    textureCompress({
      encoder: sharp,
      targetFormat: "jpeg",
      quality: 82,
      resize: [1024, 1024],
      resizeFilter: TextureResizeFilter.LANCZOS3,
    }),
    prune(),
    dedup(),
    center({ pivot: "below" })
  );

  for (const material of document.getRoot().listMaterials()) {
    material.setMetallicFactor(0);
    material.setExtension("KHR_materials_specular", null);
    material.setExtension("KHR_materials_ior", null);
    material.setAlphaMode("OPAQUE");
  }
  const orphanTexturesDisposed = disposeOrphansAndExtensions(document);


  await mkdir(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `fleming-${side}.glb`);
  await io.write(outPath, document);
  const outStat = await stat(outPath);

  const inspectTextures = [];
  for (const tex of document.getRoot().listTextures()) {
    const size = tex.getSize() || [0, 0];
    const img = tex.getImage();
    inspectTextures.push({
      name: tex.getName(),
      mime: tex.getMimeType(),
      size,
      bytes: img?.byteLength ?? 0,
    });
  }

  const result = {
    side,
    source: { path: srcPath, bytes: srcStat.size },
    output: { path: outPath, bytes: outStat.size },
    ratio: Number((outStat.size / srcStat.size).toFixed(4)),
    elapsedMs: Date.now() - started,
    naming,
    flattened,
    stripped,
    orphanTexturesDisposed,
    materialNotes,
    textures: inspectTextures,
    meshes: document.getRoot().listMeshes().map((m) => ({
      name: m.getName(),
      verts: vertexCount(m),
      primitives: m.listPrimitives().length,
    })),
    nodes: document
      .getRoot()
      .listNodes()
      .filter((n) =>
        /^(root|hand|letter-|arrow-|model-assembly)/.test(n.getName())
      )
      .map((n) => n.getName()),
  };
  console.log(
    `[${side}] ${srcStat.size} → ${outStat.size} bytes (${(result.ratio * 100).toFixed(1)}%) in ${result.elapsedMs}ms`
  );
  return result;
}

async function main() {
  await mkdir(EVIDENCE, { recursive: true });
  const reports = [];
  for (const side of ["left", "right"]) {
    reports.push(await optimizeOne(side, SRC[side]));
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    totals: {
      sourceBytes: reports.reduce((s, r) => s + r.source.bytes, 0),
      outputBytes: reports.reduce((s, r) => s + r.output.bytes, 0),
    },
    reports,
  };
  const outJson = join(EVIDENCE, "optimization-report.json");
  await writeFile(outJson, JSON.stringify(summary, null, 2));
  const md = [
    "# GLB 優化報告",
    "",
    `| 模型 | 原始大小 | 優化後 | 比例 |`,
    `| --- | ---: | ---: | ---: |`,
    ...reports.map((r) => {
      const a = (r.source.bytes / 1048576).toFixed(2);
      const b = (r.output.bytes / 1048576).toFixed(2);
      return `| ${r.side} | ${a} MB | ${b} MB | ${(r.ratio * 100).toFixed(1)}% |`;
    }),
    "",
    "處理步驟：為 F／B／I 字母與箭頭以及手部網格命名 → 鏡面光澤轉金屬粗糙 → 純色貼圖改為顏色係數 → 金屬度設為 0 → 貼圖縮至 1024 並以 JPEG 壓縮 → 去重與精簡 → 置中。",
    "",
  ].join("\n");
  await writeFile(join(EVIDENCE, "optimization-report.md"), md);
  console.log("wrote", outJson);
  if (reports.some((r) => Object.keys(r.naming.letters).length < 3 || Object.keys(r.naming.arrows).length < 3)) {
    console.error("WARNING: incomplete F/B/I classification");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
