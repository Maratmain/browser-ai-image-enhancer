import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { detectFormat } from "../../dist/src/codecs/detectFormat.js";
import { probeImage } from "../../dist/src/codecs/dimensions.js";
import { correctRgb, linearToSrgb, srgbToLinear } from "../../dist/src/processing/colorMath.js";
import { createTiles } from "../../dist/src/processing/tiling.js";
import { inferWithJavaScript } from "../../dist/src/ml/javascriptRuntime.js";
import { applySafetyGuard } from "../../dist/src/ml/safetyGuard.js";
import { TaskManager } from "../../dist/src/api/TaskManager.js";

const fixtures = resolve("tests/fixtures");

async function blob(name, type = "") {
  return new Blob([await readFile(resolve(fixtures, name))], { type });
}

function assertClose(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
}

test("detects supported formats by signature", async () => {
  assert.equal(await detectFormat(await blob("sample.jpg")), "jpeg");
  assert.equal(await detectFormat(await blob("sample.png")), "png");
  assert.equal(await detectFormat(await blob("sample24.bmp")), "bmp");
  const heicHeader = new Uint8Array([
    0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70,
    0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0,
    0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63
  ]);
  const heifHeader = new Uint8Array([
    0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70,
    0x6d, 0x69, 0x66, 0x31, 0, 0, 0, 0,
    0x6d, 0x73, 0x66, 0x31
  ]);
  assert.equal(await detectFormat(new Blob([heicHeader])), "heic");
  assert.equal(await detectFormat(new Blob([heifHeader])), "heif");
  await assert.rejects(detectFormat(await blob("invalid.bin")), (error) => error.code === "UNSUPPORTED_FORMAT");
});

test("reads dimensions and EXIF orientation", async () => {
  const jpeg = await probeImage(await blob("sample.jpg"), "jpeg");
  assert.equal(jpeg.width, 640);
  assert.equal(jpeg.height, 420);
  assert.equal(jpeg.orientation, 1);

  const rotated = await probeImage(await blob("orientation6.jpg"), "jpeg");
  assert.equal(rotated.width, 640);
  assert.equal(rotated.height, 420);
  assert.equal(rotated.orientation, 6);

  const png = await probeImage(await blob("sample.png"), "png");
  assert.equal(png.hasAlpha, true);
  const bmp = await probeImage(await blob("sample32.bmp"), "bmp");
  assert.equal(bmp.width, 96);
  assert.equal(bmp.height, 64);
});

test("sRGB conversion is stable and neutral correction is identity", () => {
  for (const value of [0, 0.01, 0.18, 0.5, 0.9, 1]) {
    assertClose(linearToSrgb(srgbToLinear(value)), value, 1e-7, "round trip");
  }
  const corrected = correctRgb(0.15, 0.48, 0.82, {
    exposureEV: 0,
    contrast: 1,
    saturation: 1,
    correctionStrength: 0,
    pivot: 0.18
  });
  assertClose(corrected[0], 0.15, 1e-7, "red");
  assertClose(corrected[1], 0.48, 1e-7, "green");
  assertClose(corrected[2], 0.82, 1e-7, "blue");
});

test("tiling covers the image without exceeding bounds", () => {
  const tiles = createTiles(5000, 3000, 2048);
  assert.equal(tiles.length, 6);
  const area = tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0);
  assert.equal(area, 15_000_000);
  for (const tile of tiles) {
    assert.ok(tile.x >= 0 && tile.y >= 0);
    assert.ok(tile.x + tile.width <= 5000);
    assert.ok(tile.y + tile.height <= 3000);
  }
});

test("JavaScript and WebAssembly inference match the training checkpoint", async () => {
  const vectors = JSON.parse(await readFile(resolve(fixtures, "model-vectors.json"), "utf8"));
  const wasmBytes = await readFile(resolve("dist/assets/model.wasm"));
  const instance = await WebAssembly.instantiate(wasmBytes, {});
  const exports = instance.instance.exports;
  const memory = new Float32Array(exports.memory.buffer);
  const inputOffset = exports.input_ptr() / 4;
  const outputOffset = exports.output_ptr() / 4;

  for (const vector of vectors) {
    const pixels = Buffer.from(vector.inputBase64, "base64");
    const input = new Float32Array(64 * 64 * 3);
    for (let index = 0; index < input.length; index += 1) input[index] = (pixels[index] / 127.5) - 1;
    const jsRaw = inferWithJavaScript(input);
    memory.set(input, inputOffset);
    exports.infer();
    const wasmRaw = memory.slice(outputOffset, outputOffset + 4);
    for (let output = 0; output < 4; output += 1) {
      assertClose(jsRaw[output], vector.raw[output], 2e-5, `${vector.id} JS output ${output}`);
      assertClose(wasmRaw[output], vector.raw[output], 2e-5, `${vector.id} WASM output ${output}`);
    }
  }
});


test("Safety Guard keeps outputs bounded and protects highlights", () => {
  const guarded = applySafetyGuard(
    { exposureEV: 1.25, contrast: 1.45, saturation: 1.5, correctionStrength: 1, pivot: 0.18 },
    {
      medianLinearLuminance: 0.45,
      p05LinearLuminance: 0.02,
      p95LinearLuminance: 0.98,
      darkFraction: 0.02,
      brightFraction: 0.18,
      meanSaturation: 0.72,
      highlySaturatedFraction: 0.2
    }
  );
  assert.ok(guarded.exposureEV >= -1.25 && guarded.exposureEV <= 1.25);
  assert.ok(guarded.contrast >= 0.7 && guarded.contrast <= 1.45);
  assert.ok(guarded.saturation >= 0.6 && guarded.saturation <= 1.5);
  assert.ok(guarded.correctionStrength < 1);
});

test("TaskManager rejects decreasing progress and releases expired state", async () => {
  const expired = [];
  const manager = new TaskManager(0, (taskId) => expired.push(taskId));
  manager.create({
    taskId: "task-1",
    status: "queued",
    progress: 0,
    stageProgress: 0,
    createdAt: 1,
    warnings: []
  });
  manager.update({
    taskId: "task-1",
    status: "validating",
    progress: 10,
    stageProgress: 50,
    createdAt: 1,
    warnings: []
  });
  assert.throws(
    () => manager.update({
      taskId: "task-1",
      status: "validating",
      progress: 9,
      stageProgress: 45,
      createdAt: 1,
      warnings: []
    }),
    (error) => error.code === "INTERNAL_ERROR"
  );
  manager.update({
    taskId: "task-1",
    status: "cancelled",
    progress: 10,
    stageProgress: 50,
    createdAt: 1,
    completedAt: 2,
    warnings: []
  });
  await assert.rejects(manager.getResult("task-1"), (error) => error.code === "TASK_CANCELLED");
  manager.remove("task-1");
  assert.throws(() => manager.get("task-1"), (error) => error.code === "TASK_NOT_FOUND");
  assert.deepEqual(expired, []);
});
