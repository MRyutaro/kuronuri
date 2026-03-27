import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.min.mjs";
import mupdf from "./vendor/mupdf/mupdf.js";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.worker.min.mjs";

const elements = {
  canvas: document.querySelector("#pdf-canvas"),
  canvasShell: document.querySelector("#canvas-shell"),
  clearPageButton: document.querySelector("#clear-page-button"),
  downloadButton: document.querySelector("#download-button"),
  dropzone: document.querySelector("#dropzone"),
  emptyState: document.querySelector("#empty-state"),
  fileInput: document.querySelector("#file-input"),
  fileName: document.querySelector("#file-name"),
  nextPageButton: document.querySelector("#next-page"),
  pageCount: document.querySelector("#page-count"),
  pageIndicator: document.querySelector("#page-indicator"),
  pageInput: document.querySelector("#page-input"),
  prevPageButton: document.querySelector("#prev-page"),
  redactionCount: document.querySelector("#redaction-count"),
  redactionList: document.querySelector("#redaction-list"),
  selectionLayer: document.querySelector("#selection-layer"),
  stage: document.querySelector("#stage"),
  statusText: document.querySelector("#status-text"),
  undoButton: document.querySelector("#undo-button"),
};

const state = {
  currentPageNumber: 1,
  currentPageSize: null,
  currentRenderToken: 0,
  currentScale: 1,
  drag: null,
  fileName: "",
  pageCache: new Map(),
  previewPdf: null,
  redactions: new Map(),
  renderTask: null,
  selectedRedactionId: null,
  sourceBytes: null,
};

const context = elements.canvas.getContext("2d", { alpha: false });

initialize();

function initialize() {
  bindEvents();
  syncControls();
  setStatus("PDF を読み込むと、ここに処理状況を表示します。");
}

function bindEvents() {
  elements.fileInput.addEventListener("change", async (event) => {
    const [file] = event.target.files ?? [];
    if (file) {
      await loadPdf(file);
    }
  });

  elements.dropzone.addEventListener("dragenter", handleDragState);
  elements.dropzone.addEventListener("dragover", handleDragState);
  elements.dropzone.addEventListener("dragleave", clearDragState);
  elements.dropzone.addEventListener("drop", async (event) => {
    event.preventDefault();
    clearDragState();
    const [file] = [...(event.dataTransfer?.files ?? [])].filter(
      (item) => item.type === "application/pdf" || item.name.toLowerCase().endsWith(".pdf"),
    );
    if (file) {
      await loadPdf(file);
    } else {
      setStatus("PDF ファイルだけを受け付けます。", true);
    }
  });

  ["dragenter", "dragover", "drop"].forEach((eventName) => {
    window.addEventListener(eventName, (event) => event.preventDefault());
  });

  elements.prevPageButton.addEventListener("click", () => changePage(state.currentPageNumber - 1));
  elements.nextPageButton.addEventListener("click", () => changePage(state.currentPageNumber + 1));

  elements.pageInput.addEventListener("change", () => {
    const nextPage = Number.parseInt(elements.pageInput.value, 10);
    if (Number.isFinite(nextPage)) {
      changePage(nextPage);
    } else {
      syncControls();
    }
  });

  elements.undoButton.addEventListener("click", () => {
    const pageRedactions = getPageRedactions(state.currentPageNumber);
    if (!pageRedactions.length) {
      return;
    }
    pageRedactions.pop();
    state.selectedRedactionId = null;
    persistPageRedactions(state.currentPageNumber, pageRedactions);
    renderRedactions();
    renderRedactionList();
    syncControls();
    setStatus(`ページ ${state.currentPageNumber} の最新の黒塗りを取り消しました。`);
  });

  elements.clearPageButton.addEventListener("click", () => {
    if (!getPageRedactions(state.currentPageNumber).length) {
      return;
    }
    state.redactions.delete(state.currentPageNumber);
    state.selectedRedactionId = null;
    renderRedactions();
    renderRedactionList();
    syncControls();
    setStatus(`ページ ${state.currentPageNumber} の黒塗りをクリアしました。`);
  });

  elements.downloadButton.addEventListener("click", async () => {
    await exportPdf();
  });

  elements.selectionLayer.addEventListener("pointerdown", startDraftRedaction);
  elements.selectionLayer.addEventListener("pointermove", updateDraftRedaction);
  elements.selectionLayer.addEventListener("pointerup", finalizeDraftRedaction);
  elements.selectionLayer.addEventListener("pointercancel", cancelDraftRedaction);
  elements.selectionLayer.addEventListener("click", handleSelectionClick);

  elements.redactionList.addEventListener("click", (event) => {
    const selectTarget = event.target.closest("[data-select-redaction]");
    const deleteTarget = event.target.closest("[data-delete-redaction]");

    if (deleteTarget) {
      deleteRedactionById(state.currentPageNumber, deleteTarget.dataset.deleteRedaction);
      return;
    }

    if (selectTarget) {
      state.selectedRedactionId = selectTarget.dataset.selectRedaction;
      renderRedactions();
      renderRedactionList();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!state.selectedRedactionId) {
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      const activeTag = document.activeElement?.tagName;
      if (activeTag === "INPUT" || activeTag === "TEXTAREA" || activeTag === "SELECT") {
        return;
      }
      deleteRedactionById(state.currentPageNumber, state.selectedRedactionId);
    }
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (!state.previewPdf) {
      return;
    }
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      renderCurrentPage().catch(() => {
        setStatus("ウィンドウのリサイズ後に再描画できませんでした。", true);
      });
    }, 120);
  });
}

function handleDragState(event) {
  event.preventDefault();
  elements.dropzone.classList.add("is-dragging");
}

function clearDragState() {
  elements.dropzone.classList.remove("is-dragging");
}

async function loadPdf(file) {
  try {
    resetStateForNewFile();
    setStatus("PDF を読み込んでいます...");

    const buffer = await file.arrayBuffer();
    state.sourceBytes = new Uint8Array(buffer);
    state.fileName = file.name;
    state.previewPdf = await pdfjsLib.getDocument({ data: state.sourceBytes.slice() }).promise;
    state.currentPageNumber = 1;

    elements.fileName.textContent = state.fileName;
    elements.pageCount.textContent = String(state.previewPdf.numPages);
    elements.pageInput.max = String(state.previewPdf.numPages);

    await renderCurrentPage();

    elements.stage.classList.add("has-document");
    elements.emptyState.classList.add("hidden");
    elements.emptyState.setAttribute("aria-hidden", "true");
    elements.canvasShell.classList.remove("hidden");

    setStatus(
      `${state.fileName} を読み込みました。保存時には MuPDF.js で実 redaction を行い、覆ったテキストを PDF から削除します。`,
    );
    syncControls();
  } catch (error) {
    console.error(error);
    setStatus("PDF の読み込みに失敗しました。破損した PDF か、未対応の形式の可能性があります。", true);
    resetStateForNewFile();
    syncControls();
  }
}

function resetStateForNewFile() {
  if (state.renderTask) {
    state.renderTask.cancel();
    state.renderTask = null;
  }

  state.currentPageNumber = 1;
  state.currentPageSize = null;
  state.currentRenderToken = 0;
  state.currentScale = 1;
  state.drag = null;
  state.fileName = "";
  state.pageCache.clear();
  state.previewPdf = null;
  state.redactions.clear();
  state.selectedRedactionId = null;
  state.sourceBytes = null;

  context.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
  elements.selectionLayer.replaceChildren();
  elements.stage.classList.remove("has-document");
  elements.canvasShell.classList.add("hidden");
  elements.emptyState.classList.remove("hidden");
  elements.emptyState.setAttribute("aria-hidden", "false");
  elements.fileName.textContent = "未選択";
  elements.pageCount.textContent = "-";
  elements.redactionCount.textContent = "0";
  elements.pageIndicator.textContent = "ページ 0 / 0";
  elements.redactionList.innerHTML = "";
  elements.pageInput.value = "1";
  elements.pageInput.max = "1";
}

async function changePage(nextPage) {
  if (!state.previewPdf) {
    return;
  }

  const clampedPage = clamp(nextPage, 1, state.previewPdf.numPages);
  if (clampedPage === state.currentPageNumber) {
    syncControls();
    return;
  }

  state.currentPageNumber = clampedPage;
  state.selectedRedactionId = null;
  await renderCurrentPage();
  setStatus(`ページ ${state.currentPageNumber} を表示しています。`);
}

async function renderCurrentPage() {
  if (!state.previewPdf) {
    return;
  }

  const renderToken = ++state.currentRenderToken;
  const page = await getCachedPage(state.currentPageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const fitScale = calculateFitScale(baseViewport.width);
  const effectiveScale = fitScale;
  const viewport = page.getViewport({ scale: effectiveScale });
  const outputScale = window.devicePixelRatio || 1;

  if (state.renderTask) {
    state.renderTask.cancel();
  }

  elements.canvas.width = Math.ceil(viewport.width * outputScale);
  elements.canvas.height = Math.ceil(viewport.height * outputScale);
  elements.canvas.style.width = `${viewport.width}px`;
  elements.canvas.style.height = `${viewport.height}px`;
  elements.selectionLayer.style.width = `${viewport.width}px`;
  elements.selectionLayer.style.height = `${viewport.height}px`;

  const transform = outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0];
  const renderTask = page.render({
    canvasContext: context,
    transform,
    viewport,
  });

  state.renderTask = renderTask;

  try {
    await renderTask.promise;
  } catch (error) {
    if (error?.name !== "RenderingCancelledException") {
      throw error;
    }
    return;
  }

  if (renderToken !== state.currentRenderToken) {
    return;
  }

  state.currentScale = effectiveScale;
  state.currentPageSize = {
    width: baseViewport.width,
    height: baseViewport.height,
  };

  renderRedactions();
  renderRedactionList();
  syncControls();
}

async function getCachedPage(pageNumber) {
  if (!state.pageCache.has(pageNumber)) {
    state.pageCache.set(pageNumber, await state.previewPdf.getPage(pageNumber));
  }
  return state.pageCache.get(pageNumber);
}

function calculateFitScale(pageWidth) {
  const stageWidth = elements.stage.clientWidth - 48;
  if (stageWidth <= 0) {
    return 1;
  }
  return Math.min(stageWidth / pageWidth, 1.8);
}

function handleSelectionClick(event) {
  const redactionNode = event.target.closest(".redaction-box");
  if (!redactionNode) {
    state.selectedRedactionId = null;
    renderRedactions();
    renderRedactionList();
    return;
  }
  state.selectedRedactionId = redactionNode.dataset.id;
  renderRedactions();
  renderRedactionList();
}

function startDraftRedaction(event) {
  if (!state.currentPageSize || event.button !== 0) {
    return;
  }
  if (event.target.closest(".redaction-box")) {
    return;
  }

  const { x, y } = getLayerPoint(event);
  const draftNode = document.createElement("div");
  draftNode.className = "redaction-box is-draft";
  updateBoxNode(draftNode, x, y, x, y);
  elements.selectionLayer.appendChild(draftNode);

  state.drag = {
    id: event.pointerId,
    originX: x,
    originY: y,
    draftNode,
  };

  elements.selectionLayer.setPointerCapture(event.pointerId);
}

function updateDraftRedaction(event) {
  if (!state.drag || event.pointerId !== state.drag.id) {
    return;
  }
  const { x, y } = getLayerPoint(event);
  updateBoxNode(state.drag.draftNode, state.drag.originX, state.drag.originY, x, y);
}

function finalizeDraftRedaction(event) {
  if (!state.drag || event.pointerId !== state.drag.id) {
    return;
  }

  const { originX, originY } = state.drag;
  const { x, y } = getLayerPoint(event);
  cleanupDraft(event.pointerId);

  addRedactionFromViewportPoints(originX, originY, x, y);
}

function cancelDraftRedaction(event) {
  if (!state.drag || event.pointerId !== state.drag.id) {
    return;
  }
  cleanupDraft(event.pointerId);
}

function cleanupDraft(pointerId) {
  if (!state.drag) {
    return;
  }
  state.drag.draftNode.remove();
  if (elements.selectionLayer.hasPointerCapture(pointerId)) {
    elements.selectionLayer.releasePointerCapture(pointerId);
  }
  state.drag = null;
}

function addRedactionFromViewportPoints(startX, startY, endX, endY) {
  if (!state.currentPageSize) {
    return;
  }

  const left = clamp(Math.min(startX, endX) / state.currentScale, 0, state.currentPageSize.width);
  const top = clamp(Math.min(startY, endY) / state.currentScale, 0, state.currentPageSize.height);
  const right = clamp(Math.max(startX, endX) / state.currentScale, 0, state.currentPageSize.width);
  const bottom = clamp(Math.max(startY, endY) / state.currentScale, 0, state.currentPageSize.height);

  if (right - left < 4 || bottom - top < 4) {
    setStatus("黒塗り範囲は、少し大きめにドラッグしてください。", true);
    return;
  }

  const pageRedactions = getPageRedactions(state.currentPageNumber);
  const redaction = {
    id: `r-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    left,
    top,
    right,
    bottom,
  };

  pageRedactions.push(redaction);
  persistPageRedactions(state.currentPageNumber, pageRedactions);
  state.selectedRedactionId = redaction.id;

  renderRedactions();
  renderRedactionList();
  syncControls();
  setStatus(`ページ ${state.currentPageNumber} に黒塗りを追加しました。`);
}

function renderRedactions() {
  elements.selectionLayer.replaceChildren();
  if (!state.currentPageSize) {
    return;
  }

  for (const redaction of getPageRedactions(state.currentPageNumber)) {
    const node = document.createElement("div");
    node.className = "redaction-box";
    if (redaction.id === state.selectedRedactionId) {
      node.classList.add("is-selected");
    }
    node.dataset.id = redaction.id;
    updateBoxNode(
      node,
      redaction.left * state.currentScale,
      redaction.top * state.currentScale,
      redaction.right * state.currentScale,
      redaction.bottom * state.currentScale,
    );
    elements.selectionLayer.appendChild(node);
  }
}

function renderRedactionList() {
  const pageRedactions = getPageRedactions(state.currentPageNumber);
  if (!pageRedactions.length) {
    elements.redactionList.innerHTML =
      '<li class="redaction-item"><div><strong>まだありません</strong><p>プレビュー上をドラッグすると追加されます。</p></div></li>';
    return;
  }

  const fragment = document.createDocumentFragment();

  pageRedactions.forEach((redaction, index) => {
    const item = document.createElement("li");
    item.className = "redaction-item";
    if (redaction.id === state.selectedRedactionId) {
      item.classList.add("is-selected");
    }

    const width = Math.round(redaction.right - redaction.left);
    const height = Math.round(redaction.bottom - redaction.top);

    item.innerHTML = `
      <button type="button" class="unstyled-select" data-select-redaction="${redaction.id}">
        <strong>黒塗り ${index + 1}</strong>
        <p>${width} x ${height} pt</p>
      </button>
      <button type="button" class="mini-button" data-delete-redaction="${redaction.id}">削除</button>
    `;

    fragment.appendChild(item);
  });

  elements.redactionList.replaceChildren(fragment);
}

function deleteRedactionById(pageNumber, redactionId) {
  const nextRedactions = getPageRedactions(pageNumber).filter((item) => item.id !== redactionId);
  persistPageRedactions(pageNumber, nextRedactions);
  if (state.selectedRedactionId === redactionId) {
    state.selectedRedactionId = null;
  }
  renderRedactions();
  renderRedactionList();
  syncControls();
  setStatus(`ページ ${pageNumber} の黒塗りを削除しました。`);
}

function getPageRedactions(pageNumber) {
  return [...(state.redactions.get(pageNumber) ?? [])];
}

function persistPageRedactions(pageNumber, redactions) {
  if (redactions.length) {
    state.redactions.set(pageNumber, redactions);
  } else {
    state.redactions.delete(pageNumber);
  }
}

async function exportPdf() {
  if (!state.sourceBytes) {
    return;
  }

  if (!countTotalRedactions()) {
    downloadBlob(new Uint8Array(state.sourceBytes), makeOutputFileName());
    setStatus("黒塗り指定がなかったため、元の PDF をそのまま保存しました。");
    return;
  }

  let document = null;
  let outputBuffer = null;

  try {
    setExporting(true);
    setStatus("MuPDF.js で実 redaction を適用しています...");

    document = new mupdf.PDFDocument(state.sourceBytes);

    for (let pageIndex = 0; pageIndex < document.countPages(); pageIndex += 1) {
      const pageNumber = pageIndex + 1;
      const redactions = getPageRedactions(pageNumber);
      if (!redactions.length) {
        continue;
      }

      setStatus(`ページ ${pageNumber} / ${document.countPages()} に実 redaction を適用しています...`);
      const page = document.loadPage(pageIndex);

      try {
        for (const redaction of redactions) {
          const annot = page.createAnnotation("Redact");
          annot.setRect([redaction.left, redaction.top, redaction.right, redaction.bottom]);
        }

        page.applyRedactions(
          true,
          mupdf.PDFPage.REDACT_IMAGE_PIXELS,
          mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED,
          mupdf.PDFPage.REDACT_TEXT_REMOVE,
        );
      } finally {
        page.destroy();
      }
    }

    outputBuffer = document.saveToBuffer("garbage=2,compress=yes");
    const outputBytes = new Uint8Array(outputBuffer.asUint8Array());
    downloadBlob(outputBytes, makeOutputFileName());
    setStatus("黒塗り済み PDF を保存しました。指定範囲のテキストは PDF から削除されています。");
  } catch (error) {
    console.error(error);
    setStatus("PDF の書き出しに失敗しました。対応していない PDF 構造の可能性があります。", true);
  } finally {
    outputBuffer?.destroy();
    document?.destroy();
    setExporting(false);
  }
}

function makeOutputFileName() {
  const baseName = state.fileName.replace(/\.pdf$/i, "") || "redacted";
  return `${baseName}-redacted.pdf`;
}

function setExporting(isExporting) {
  elements.downloadButton.disabled = isExporting || !state.previewPdf;
  elements.undoButton.disabled = isExporting || !getPageRedactions(state.currentPageNumber).length;
  elements.clearPageButton.disabled =
    isExporting || !getPageRedactions(state.currentPageNumber).length;
  elements.prevPageButton.disabled = isExporting || state.currentPageNumber <= 1;
  elements.nextPageButton.disabled =
    isExporting || !state.previewPdf || state.currentPageNumber >= state.previewPdf.numPages;
  elements.pageInput.disabled = isExporting || !state.previewPdf;
}

function syncControls() {
  elements.pageInput.value = String(state.currentPageNumber);
  elements.redactionCount.textContent = String(countTotalRedactions());

  if (!state.previewPdf) {
    setExporting(false);
    elements.downloadButton.disabled = true;
    elements.undoButton.disabled = true;
    elements.clearPageButton.disabled = true;
    elements.prevPageButton.disabled = true;
    elements.nextPageButton.disabled = true;
    elements.pageInput.disabled = true;
    return;
  }

  elements.pageIndicator.textContent = `ページ ${state.currentPageNumber} / ${state.previewPdf.numPages}`;
  elements.prevPageButton.disabled = state.currentPageNumber <= 1;
  elements.nextPageButton.disabled = state.currentPageNumber >= state.previewPdf.numPages;
  elements.pageInput.disabled = false;
  elements.undoButton.disabled = !getPageRedactions(state.currentPageNumber).length;
  elements.clearPageButton.disabled = !getPageRedactions(state.currentPageNumber).length;
  elements.downloadButton.disabled = false;
}

function countTotalRedactions() {
  return [...state.redactions.values()].reduce((sum, redactions) => sum + redactions.length, 0);
}

function getLayerPoint(event) {
  const bounds = elements.selectionLayer.getBoundingClientRect();
  const x = clamp(event.clientX - bounds.left, 0, bounds.width);
  const y = clamp(event.clientY - bounds.top, 0, bounds.height);
  return { x, y };
}

function updateBoxNode(node, x1, y1, x2, y2) {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
  node.style.width = `${width}px`;
  node.style.height = `${height}px`;
}

function setStatus(message, isError = false) {
  elements.statusText.textContent = message;
  elements.statusText.style.color = isError ? "#8d1f13" : "";
}

function downloadBlob(bytes, fileName) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
