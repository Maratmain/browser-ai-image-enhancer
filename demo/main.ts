import {
  ImageEnhancer,
  EnhancerError,
  type EnhancerCapabilities,
  type StatusChangeDetail,
  type TaskInfo
} from "../src/index.js";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Missing element: ${id}`);
  return found as T;
}

const fileInput = element<HTMLInputElement>("file-input");
const dropZone = element<HTMLElement>("drop-zone");
const fileCard = element<HTMLElement>("file-card");
const fileName = element<HTMLElement>("file-name");
const fileMeta = element<HTMLElement>("file-meta");
const removeButton = element<HTMLButtonElement>("remove-button");
const enhanceButton = element<HTMLButtonElement>("enhance-button");
const cancelButton = element<HTMLButtonElement>("cancel-button");
const outputType = element<HTMLSelectElement>("output-type");
const processingBackend = element<HTMLSelectElement>("processing-backend");
const progressBlock = element<HTMLElement>("progress-block");
const progressBar = element<HTMLElement>("progress-bar");
const progressValue = element<HTMLElement>("progress-value");
const statusLabel = element<HTMLElement>("status-label");
const errorBox = element<HTMLElement>("error-box");
const warningBox = element<HTMLElement>("warning-box");
const emptyPreview = element<HTMLElement>("empty-preview");
const comparison = element<HTMLElement>("comparison");
const beforeImage = element<HTMLImageElement>("before-image");
const afterImage = element<HTMLImageElement>("after-image");
const beforeLayer = element<HTMLElement>("before-layer");
const comparisonDivider = element<HTMLElement>("comparison-divider");
const comparisonRange = element<HTMLInputElement>("comparison-range");
const resultSection = element<HTMLElement>("result-section");
const downloadButton = element<HTMLButtonElement>("download-button");
const capabilitiesGrid = element<HTMLElement>("capabilities-grid");
const diagnosticsButton = element<HTMLButtonElement>("diagnostics-button");
const diagnosticsOutput = element<HTMLElement>("diagnostics-output");

const enhancer = new ImageEnhancer();
let selectedFile: File | undefined;
let currentTaskId: string | undefined;
let resultBlob: Blob | undefined;
let originalUrl: string | undefined;
let resultUrl: string | undefined;

const statusNames: Record<string, string> = {
  queued: "В очереди",
  validating: "Проверка файла",
  decoding: "Декодирование",
  normalizing: "Ориентация и нормализация",
  analyzing: "Анализ изображения моделью",
  enhancing: "Полноразмерная коррекция",
  encoding: "Кодирование результата",
  cancelling: "Отмена",
  cancelled: "Отменено",
  completed: "Готово",
  failed: "Ошибка"
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function releaseUrls(): void {
  if (originalUrl !== undefined) URL.revokeObjectURL(originalUrl);
  if (resultUrl !== undefined) URL.revokeObjectURL(resultUrl);
  originalUrl = undefined;
  resultUrl = undefined;
}

function resetResult(): void {
  resultBlob = undefined;
  resultSection.classList.add("hidden");
  comparison.classList.add("hidden");
  emptyPreview.classList.remove("hidden");
  progressBlock.classList.add("hidden");
  cancelButton.classList.add("hidden");
  errorBox.classList.add("hidden");
  warningBox.classList.add("hidden");
  releaseUrls();
}

function selectFile(file: File): void {
  if (currentTaskId !== undefined) return;
  resetResult();
  selectedFile = file;
  fileName.textContent = file.name;
  fileMeta.textContent = `${formatBytes(file.size)} · ${file.type || "тип определяется по сигнатуре"}`;
  fileCard.classList.remove("hidden");
  enhanceButton.disabled = false;
  originalUrl = URL.createObjectURL(file);
  beforeImage.src = originalUrl;
}

function clearFile(): void {
  selectedFile = undefined;
  fileInput.value = "";
  fileCard.classList.add("hidden");
  enhanceButton.disabled = true;
  resetResult();
}

function renderTask(task: TaskInfo): void {
  statusLabel.textContent = statusNames[task.status] ?? task.status;
  progressValue.textContent = `${Math.round(task.progress)}%`;
  progressBar.style.width = `${task.progress}%`;
  progressBar.parentElement?.setAttribute("aria-valuenow", String(Math.round(task.progress)));

  if (task.warnings.length > 0) {
    warningBox.textContent = task.warnings.map((warning) => warning.message).join(" ");
    warningBox.classList.remove("hidden");
  }
  if (task.error !== undefined) {
    errorBox.textContent = `${task.error.code}: ${task.error.message}`;
    errorBox.classList.remove("hidden");
  }
  if (task.status === "completed") renderMetrics(task);
}

function renderMetrics(task: TaskInfo): void {
  const parameters = task.parameters;
  element("metric-exposure").textContent = parameters === undefined ? "—" : `${parameters.exposureEV >= 0 ? "+" : ""}${parameters.exposureEV.toFixed(2)} EV`;
  element("metric-contrast").textContent = parameters?.contrast.toFixed(2) ?? "—";
  element("metric-saturation").textContent = parameters?.saturation.toFixed(2) ?? "—";
  element("metric-strength").textContent = parameters === undefined ? "—" : `${Math.round(parameters.correctionStrength * 100)}%`;
  element("metric-time").textContent = task.processingTimeMs === undefined ? "—" : `${(task.processingTimeMs / 1000).toFixed(2)} с`;
  element("metric-backend").textContent = `${task.processingBackend ?? "—"} · ${task.inferenceBackend ?? "—"}`;

  const timingTable = element("timing-table");
  timingTable.replaceChildren();
  if (task.timings !== undefined) {
    const labels: Record<string, string> = {
      validationMs: "Проверка",
      decodingMs: "Декодирование",
      normalizationMs: "Нормализация",
      previewMs: "Preview",
      inferenceMs: "ML inference",
      safetyGuardMs: "Safety Guard",
      enhancementMs: "Коррекция",
      encodingMs: "Кодирование"
    };
    for (const [key, label] of Object.entries(labels)) {
      const node = document.createElement("div");
      const value = task.timings[key as keyof typeof task.timings];
      node.textContent = `${label}: ${Number(value).toFixed(1)} мс`;
      timingTable.append(node);
    }
  }
  resultSection.classList.remove("hidden");
}

function capabilityCard(label: string, passed: boolean, value?: string): HTMLElement {
  const article = document.createElement("article");
  const caption = document.createElement("span");
  const result = document.createElement("strong");
  caption.textContent = label;
  result.textContent = value ?? (passed ? "PASS" : "FAIL");
  result.className = passed ? "pass" : "fail";
  article.append(caption, result);
  return article;
}

function renderCapabilities(capabilities: EnhancerCapabilities): void {
  capabilitiesGrid.replaceChildren(
    capabilityCard("Web Worker", capabilities.worker),
    capabilityCard("OffscreenCanvas", capabilities.offscreenCanvas),
    capabilityCard("WebGL2", capabilities.webgl2, capabilities.webgl2 ? `PASS · ${capabilities.maxTextureSize ?? "?"} px` : "FALLBACK"),
    capabilityCard("WebAssembly ML", capabilities.wasm, capabilities.inferenceBackend.toUpperCase()),
    capabilityCard("JPEG encoder", capabilities.jpegEncode),
    capabilityCard("PNG encoder", capabilities.pngEncode)
  );
}

async function processSelected(): Promise<void> {
  if (selectedFile === undefined || currentTaskId !== undefined) return;
  errorBox.classList.add("hidden");
  warningBox.classList.add("hidden");
  progressBlock.classList.remove("hidden");
  cancelButton.classList.remove("hidden");
  enhanceButton.disabled = true;
  const taskId = enhancer.createTask(selectedFile, {
    outputType: outputType.value as "auto" | "image/jpeg" | "image/png",
    processingBackend: processingBackend.value as "auto" | "webgl2" | "cpu"
  });
  currentTaskId = taskId;
  try {
    resultBlob = await enhancer.getResult(taskId);
    const task = enhancer.getStatus(taskId);
    resultUrl = URL.createObjectURL(resultBlob);
    afterImage.src = resultUrl;
    beforeImage.src = originalUrl ?? "";
    emptyPreview.classList.add("hidden");
    comparison.classList.remove("hidden");
    renderTask(task);
  } catch (error) {
    const message = error instanceof EnhancerError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
    errorBox.textContent = message;
    errorBox.classList.remove("hidden");
  } finally {
    currentTaskId = undefined;
    cancelButton.classList.add("hidden");
    enhanceButton.disabled = selectedFile === undefined;
  }
}

enhancer.addEventListener("statuschange", (event) => {
  const detail = (event as CustomEvent<StatusChangeDetail>).detail;
  if (detail.taskId === currentTaskId) renderTask(detail.task);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file !== undefined) selectFile(file);
});
for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  });
}
dropZone.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files[0];
  if (file !== undefined) selectFile(file);
});
removeButton.addEventListener("click", clearFile);
enhanceButton.addEventListener("click", () => void processSelected());
cancelButton.addEventListener("click", () => {
  if (currentTaskId !== undefined) void enhancer.abortTask(currentTaskId);
});
downloadButton.addEventListener("click", () => {
  if (resultBlob === undefined || resultUrl === undefined) return;
  const anchor = document.createElement("a");
  const base = (selectedFile?.name ?? "enhanced-image").replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "-");
  const extension = resultBlob.type === "image/jpeg" ? "jpg" : "png";
  anchor.href = resultUrl;
  anchor.download = `${base || "enhanced-image"}-enhanced.${extension}`;
  anchor.click();
});
comparisonRange.addEventListener("input", () => {
  const value = Number(comparisonRange.value);
  beforeLayer.style.clipPath = `inset(0 ${100 - value}% 0 0)`;
  beforeLayer.style.setProperty("--divider-position", `${value}%`);
  comparisonDivider.style.left = `${value}%`;
});

diagnosticsButton.addEventListener("click", async () => {
  diagnosticsButton.disabled = true;
  diagnosticsOutput.classList.remove("hidden");
  diagnosticsOutput.textContent = "Запуск полного self-test…";
  const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 320;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas 2D unavailable");
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#121b34");
    gradient.addColorStop(0.5, "#d08165");
    gradient.addColorStop(1, "#e9d6a0");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value === null ? reject(new Error("PNG encode failed")) : resolve(value), "image/png"));
    const runs = [];
    for (const backend of ["cpu", "auto"] as const) {
      const taskId = enhancer.createTask(blob, { outputType: "image/png", processingBackend: backend });
      const output = await enhancer.getResult(taskId);
      const task = enhancer.getStatus(taskId);
      runs.push({ backend, status: task.status, bytes: output.size, processingMs: task.processingTimeMs, actualBackend: task.processingBackend });
      await enhancer.disposeTask(taskId);
    }
    report.status = "PASS";
    report.runs = runs;
  } catch (error) {
    report.status = "FAIL";
    report.error = error instanceof Error ? error.message : String(error);
  }
  report.finishedAt = new Date().toISOString();
  diagnosticsOutput.textContent = JSON.stringify(report, null, 2);
  diagnosticsButton.disabled = false;
});

void enhancer.ready()
  .then(renderCapabilities)
  .catch((error: unknown) => {
    capabilitiesGrid.replaceChildren(capabilityCard("Инициализация", false));
    errorBox.textContent = error instanceof Error ? error.message : String(error);
    errorBox.classList.remove("hidden");
  });

window.addEventListener("beforeunload", () => {
  releaseUrls();
  void enhancer.dispose();
});
