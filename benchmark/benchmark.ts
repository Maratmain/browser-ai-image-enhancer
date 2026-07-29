import { ImageEnhancer, type TaskInfo } from "../src/index.js";

interface BenchmarkRow {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
  readonly processingBackend?: string | undefined;
  readonly inferenceBackend?: string | undefined;
  readonly validationMs?: number | undefined;
  readonly decodingMs?: number | undefined;
  readonly previewMs?: number | undefined;
  readonly inferenceMs?: number | undefined;
  readonly enhancementMs?: number | undefined;
  readonly encodingMs?: number | undefined;
  readonly processingMs?: number | undefined;
  readonly outputSizeBytes?: number | undefined;
  readonly success: boolean;
  readonly error?: string | undefined;
}

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`Missing ${id}`);
  return node as T;
}

const runButton = element<HTMLButtonElement>("run-button");
const exportButton = element<HTMLButtonElement>("export-button");
const backendSelect = element<HTMLSelectElement>("backend");
const progress = element<HTMLElement>("benchmark-progress");
const status = element<HTMLElement>("benchmark-status");
const percent = element<HTMLElement>("benchmark-percent");
const bar = element<HTMLElement>("benchmark-bar");
const results = element<HTMLTableSectionElement>("results");
const summary = element<HTMLElement>("summary");
const errorOutput = element<HTMLElement>("benchmark-error");
let latestReport: Record<string, unknown> | undefined;

declare global {
  interface Window {
    __imageEnhancerBenchmarkReport?: Record<string, unknown>;
  }
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

async function makeImage(width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false });
  if (context === null) throw new Error("Canvas 2D unavailable");
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#081126");
  gradient.addColorStop(0.28, "#62546f");
  gradient.addColorStop(0.62, "#d68c70");
  gradient.addColorStop(1, "#f0daa5");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.globalAlpha = 0.55;
  for (let index = 0; index < 24; index += 1) {
    context.fillStyle = `hsl(${(index * 47) % 360} 65% ${30 + (index % 5) * 8}%)`;
    const x = ((index * 811) % width) - width * 0.05;
    const y = ((index * 577) % height) - height * 0.05;
    const radius = Math.max(20, Math.min(width, height) * (0.025 + (index % 6) * 0.008));
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
}

function renderRows(rows: BenchmarkRow[]): void {
  results.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement("tr");
    const values = [
      row.name,
      `${row.width}×${row.height}`,
      row.processingBackend ?? "—",
      row.inferenceBackend ?? "—",
      row.decodingMs === undefined ? "—" : `${row.decodingMs.toFixed(0)} ms`,
      row.enhancementMs === undefined ? "—" : `${row.enhancementMs.toFixed(0)} ms`,
      row.encodingMs === undefined ? "—" : `${row.encodingMs.toFixed(0)} ms`,
      row.processingMs === undefined ? "—" : `${(row.processingMs / 1000).toFixed(2)} s`,
      row.success ? "PASS" : row.error ?? "FAIL"
    ];
    values.forEach((value, index) => {
      const td = document.createElement("td");
      td.textContent = value;
      if (index === values.length - 1) td.className = row.success ? "pass-text" : "fail-text";
      tr.append(td);
    });
    results.append(tr);
  }
}

function summaryCard(label: string, value: string, passed: boolean): HTMLElement {
  const article = document.createElement("article");
  const caption = document.createElement("span");
  const strong = document.createElement("strong");
  caption.textContent = label;
  strong.textContent = value;
  strong.className = passed ? "pass-text" : "fail-text";
  article.append(caption, strong);
  return article;
}

async function runBenchmark(): Promise<void> {
  runButton.disabled = true;
  exportButton.disabled = true;
  errorOutput.classList.add("hidden");
  summary.classList.add("hidden");
  progress.classList.remove("hidden");
  results.replaceChildren();
  const enhancer = new ImageEnhancer({ resultRetentionMs: 60_000 });
  const rows: BenchmarkRow[] = [];
  try {
    const capabilities = await enhancer.ready();
    const cases = [
      { name: "2 MP", width: 1920, height: 1080 },
      { name: "8 MP", width: 3264, height: 2448 },
      { name: "15 MP", width: 5000, height: 3000 }
    ];

    status.textContent = "Прогрев модели";
    const warm = await makeImage(512, 512);
    const warmId = enhancer.createTask(warm, { outputType: "image/jpeg", processingBackend: backendSelect.value as "auto" | "webgl2" | "cpu" });
    await enhancer.getResult(warmId);
    await enhancer.disposeTask(warmId);

    for (let index = 0; index < cases.length; index += 1) {
      const test = cases[index]!;
      const overall = Math.round((index / cases.length) * 100);
      bar.style.width = `${overall}%`;
      percent.textContent = `${overall}%`;
      status.textContent = `Генерация ${test.name}`;
      const blob = await makeImage(test.width, test.height);
      status.textContent = `Обработка ${test.name}`;
      const taskId = enhancer.createTask(blob, {
        outputType: "image/jpeg",
        processingBackend: backendSelect.value as "auto" | "webgl2" | "cpu"
      });
      try {
        const output = await enhancer.getResult(taskId);
        const task: TaskInfo = enhancer.getStatus(taskId);
        rows.push({
          name: test.name,
          width: test.width,
          height: test.height,
          pixels: test.width * test.height,
          processingBackend: task.processingBackend,
          inferenceBackend: task.inferenceBackend,
          validationMs: task.timings?.validationMs,
          decodingMs: task.timings?.decodingMs,
          previewMs: task.timings?.previewMs,
          inferenceMs: task.timings?.inferenceMs,
          enhancementMs: task.timings?.enhancementMs,
          encodingMs: task.timings?.encodingMs,
          processingMs: task.processingTimeMs,
          outputSizeBytes: output.size,
          success: task.status === "completed"
        });
      } catch (error) {
        rows.push({
          name: test.name,
          width: test.width,
          height: test.height,
          pixels: test.width * test.height,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      await enhancer.disposeTask(taskId).catch(() => undefined);
      renderRows(rows);
    }

    bar.style.width = "100%";
    percent.textContent = "100%";
    status.textContent = "Готово";
    const times = rows.flatMap((row) => row.processingMs === undefined ? [] : [row.processingMs]);
    const mean = times.reduce((sum, value) => sum + value, 0) / Math.max(1, times.length);
    const p95 = percentile(times, 0.95);
    const maximum = Math.max(0, ...times);
    summary.replaceChildren(
      summaryCard("Среднее", `${(mean / 1000).toFixed(2)} с`, mean <= 5000),
      summaryCard("P95", `${(p95 / 1000).toFixed(2)} с`, p95 <= 15000),
      summaryCard("Максимум", `${(maximum / 1000).toFixed(2)} с`, maximum <= 30000)
    );
    summary.classList.remove("hidden");
    latestReport = {
      generatedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      capabilities,
      requestedBackend: backendSelect.value,
      thresholdsMs: { mean: 5000, p95: 15000, maximum: 30000 },
      summary: { mean, p95, maximum },
      rows
    };
    window.__imageEnhancerBenchmarkReport = latestReport;
    exportButton.disabled = false;
  } catch (error) {
    errorOutput.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
    errorOutput.classList.remove("hidden");
  } finally {
    await enhancer.dispose();
    runButton.disabled = false;
  }
}

runButton.addEventListener("click", () => void runBenchmark());
exportButton.addEventListener("click", () => {
  if (latestReport === undefined) return;
  const blob = new Blob([JSON.stringify(latestReport, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "browser-image-enhancer-benchmark.json";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
