import {
  FilesetResolver,
  HandLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const LM = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_TIP: 12,
  RING_TIP: 16,
  PINKY_TIP: 20,
  MIDDLE_MCP: 9,
  RING_MCP: 13,
  PINKY_MCP: 17,
};

const PINCH_THRESHOLD = 0.055;
const FRAME_PADDING = 28;
const FREEZE_HOLD_MS = 250;
const COUNTDOWN_SECONDS = 3;
const FIST_HOLD_FRAMES = 12;
const SNAP_DISTANCE_RATIO = 0.75;
const GRID = 3;
const LOAD_TIMEOUT_MS = 20000;

const PHOTOBOOTH_CONTRAST_ALPHA = 1.3;
const PHOTOBOOTH_BRIGHTNESS_BETA = 10;
const PHOTOBOOTH_NOISE_STD = 15;

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const videoEl = document.getElementById("webcam");
const canvas = document.getElementById("sceneCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const loadingOverlay = document.getElementById("loadingOverlay");
const loaderText = document.getElementById("loaderText");
const loaderRetry = document.getElementById("loaderRetry");
const errorBanner = document.getElementById("errorBanner");
const progressBadge = document.getElementById("progressBadge");
const progressText = document.getElementById("progressText");

const galleryStrip = document.getElementById("galleryStrip");
const galleryEmpty = document.getElementById("galleryEmpty");
const galleryCount = document.getElementById("galleryCount");
const downloadStripBtn = document.getElementById("downloadStripBtn");
const downloadVideoBtn = document.getElementById("downloadVideoBtn");
const resetAllBtn = document.getElementById("resetAllBtn");
const stripCompleteMsg = document.getElementById("stripCompleteMsg");
const recIndicator = document.getElementById("recIndicator");
const flashOverlay = document.getElementById("flashOverlay");
const stripModal = document.getElementById("stripModal");
const stripPreviewCanvas = document.getElementById("stripPreviewCanvas");
const stripModalDownload = document.getElementById("stripModalDownload");
const stripModalClose = document.getElementById("stripModalClose");

// ── Audio engine ──────────────────────────────────────────────────────────────
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function resumeAudio() { if (audioCtx.state === "suspended") audioCtx.resume(); }

function playTone({ freq = 440, type = "sine", gain = 0.18, attack = 0.005, decay = 0.12, duration = 0.15 } = {}) {
  resumeAudio();
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const env = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(gain, now + attack);
  env.gain.exponentialRampToValueAtTime(0.001, now + attack + decay);
  osc.connect(env);
  env.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + duration);
}

function playNoise({ gain = 0.25, duration = 0.18, freq = 800 } = {}) {
  resumeAudio();
  const now = audioCtx.currentTime;
  const bufSize = audioCtx.sampleRate * duration;
  const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const filter = audioCtx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = freq;
  filter.Q.value = 0.8;
  const env = audioCtx.createGain();
  env.gain.setValueAtTime(gain, now);
  env.gain.exponentialRampToValueAtTime(0.001, now + duration);
  src.connect(filter);
  filter.connect(env);
  env.connect(audioCtx.destination);
  src.start(now);
  src.stop(now + duration);
}

function soundCountdownBeep(number) {
  const freqs = { 3: 660, 2: 880, 1: 1100 };
  playTone({ freq: freqs[number] || 660, gain: 0.22, decay: 0.18, duration: 0.22 });
}

function soundSnap() {
  playTone({ freq: 1400, type: "square", gain: 0.1, attack: 0.001, decay: 0.06, duration: 0.08 });
}

function soundShatter() {
  playNoise({ gain: 0.35, duration: 0.25, freq: 400 });
  playTone({ freq: 90, type: "sawtooth", gain: 0.3, attack: 0.001, decay: 0.22, duration: 0.25 });
}

function soundComplete() {
  [523, 659, 784, 1047].forEach((freq, i) => {
    const now = audioCtx.currentTime + i * 0.1;
    const osc = audioCtx.createOscillator();
    const env = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now);
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.18, now + 0.01);
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.connect(env);
    env.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
  });
}

function soundSaved() {
  playTone({ freq: 880, gain: 0.12, decay: 0.3, duration: 0.32 });
}

function triggerFlash() {
  flashOverlay.classList.add("flash");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      flashOverlay.classList.remove("flash");
    });
  });
}

function applyVignette(canvas) {
  const ctx2 = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const grad = ctx2.createRadialGradient(w/2, h/2, Math.min(w,h)*0.25, w/2, h/2, Math.max(w,h)*0.75);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx2.fillStyle = grad;
  ctx2.fillRect(0, 0, w, h);
}

// ── Video recorder ────────────────────────────────────────────────────────────
const recorder = {
  instance: null,
  chunks: [],
  blob: null,
};

function startRecording() {
  recorder.chunks = [];
  recorder.blob = null;
  downloadVideoBtn.disabled = true;
  try {
    const stream = canvas.captureStream(30);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";
    recorder.instance = new MediaRecorder(stream, { mimeType });
    recorder.instance.ondataavailable = (e) => { if (e.data.size > 0) recorder.chunks.push(e.data); };
    recorder.instance.onstop = () => {
      recorder.blob = new Blob(recorder.chunks, { type: "video/webm" });
      downloadVideoBtn.disabled = false;
      recIndicator.classList.add("hidden");
    };
    recorder.instance.start();
    recIndicator.classList.remove("hidden");
  } catch (err) {
    console.warn("[PuzzleCam] MediaRecorder failed:", err);
  }
}

function stopRecording() {
  if (recorder.instance && recorder.instance.state !== "inactive") {
    recorder.instance.stop();
  }
}

function downloadVideo() {
  if (!recorder.blob) return;
  const url = URL.createObjectURL(recorder.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `puzzlecam_solve_${Date.now()}.webm`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ── App state ─────────────────────────────────────────────────────────────────
let appState = "tracking";

const puzzle = {
  boardBox: null,
  pieces: [],
  solved: false,
  solvedAt: null,
  tileW: 0,
  tileH: 0,
};

const SHATTER_COLS = 6;
const SHATTER_ROWS = 6;
const SHATTER_DURATION_MS = 850;
const shatter = {
  active: false,
  startedAt: 0,
  fragments: [],
  pendingCanvas: null,
};

const STRIP_MAX_PHOTOS = 3;
const galleryEntries = [];

function addToGallery(snapshotCanvas) {
  if (galleryEntries.length >= STRIP_MAX_PHOTOS) return;
  galleryEntries.push({ canvas: snapshotCanvas, time: Date.now() });
  renderGalleryThumb(snapshotCanvas, galleryEntries.length);
  galleryCount.textContent = `${galleryEntries.length} / ${STRIP_MAX_PHOTOS}`;
  if (galleryEmpty) galleryEmpty.style.display = "none";
  if (galleryEntries.length >= STRIP_MAX_PHOTOS) showStripComplete();
}

function isStripFull() {
  return galleryEntries.length >= STRIP_MAX_PHOTOS;
}

function showStripComplete() {
  if (stripCompleteMsg) stripCompleteMsg.classList.add("visible");
  updateStripDownloadAvailability();
  downloadPhotoStrip();
  setTimeout(() => showStripModal(), 900);
}

function hideStripComplete() {
  if (stripCompleteMsg) stripCompleteMsg.classList.remove("visible");
}

function updateStripDownloadAvailability() {
  if (!downloadStripBtn) return;
  downloadStripBtn.disabled = galleryEntries.length === 0;
}

const STRIP_FILE_BORDER = 24;
const STRIP_FILE_GAP = 16;
const STRIP_FILE_BG = "#ffffff";

function buildStripCanvas() {
  if (galleryEntries.length === 0) return null;
  const polaroids = galleryEntries.map((entry, i) => makePolaroid(entry.canvas, i + 1));
  const totalW = polaroids[0].width + STRIP_FILE_BORDER * 2;
  const totalH = STRIP_FILE_BORDER * 2 +
    polaroids.reduce((sum, p) => sum + p.height, 0) +
    STRIP_FILE_GAP * (polaroids.length - 1);
  const sc = document.createElement("canvas");
  sc.width = totalW;
  sc.height = totalH;
  const sCtx = sc.getContext("2d");
  sCtx.fillStyle = "#f0ede6";
  sCtx.fillRect(0, 0, totalW, totalH);
  let cursorY = STRIP_FILE_BORDER;
  polaroids.forEach((p) => {
    sCtx.drawImage(p, STRIP_FILE_BORDER, cursorY);
    cursorY += p.height + STRIP_FILE_GAP;
  });
  return sc;
}

function downloadPhotoStrip() {
  const sc = buildStripCanvas();
  if (!sc) return;
  sc.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `puzzlecam_strip_${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, "image/png");
}

function showStripModal() {
  const sc = buildStripCanvas();
  if (!sc) return;
  stripPreviewCanvas.width = sc.width;
  stripPreviewCanvas.height = sc.height;
  stripPreviewCanvas.getContext("2d").drawImage(sc, 0, 0);
  stripModal.classList.remove("hidden");
}

function resetEverything() {
  galleryEntries.length = 0;
  galleryStrip.innerHTML = "";
  galleryCount.textContent = `0 / ${STRIP_MAX_PHOTOS}`;
  if (galleryEmpty) {
    galleryEmpty.style.display = "block";
    galleryStrip.appendChild(galleryEmpty);
  }
  hideStripComplete();
  updateStripDownloadAvailability();
  resetPuzzleOnly();
  statusText.textContent = "everything reset";
}

function makePolaroid(snapshotCanvas, index) {
  const BORDER = 10;
  const BOTTOM = 32;
  const THUMB_W = 200;
  const scale = THUMB_W / snapshotCanvas.width;
  const imgH = Math.round(snapshotCanvas.height * scale);
  const pc = document.createElement("canvas");
  pc.width = THUMB_W + BORDER * 2;
  pc.height = imgH + BORDER + BOTTOM;
  const pCtx = pc.getContext("2d");
  pCtx.fillStyle = "#fff";
  pCtx.fillRect(0, 0, pc.width, pc.height);
  pCtx.drawImage(snapshotCanvas, BORDER, BORDER, THUMB_W, imgH);
  pCtx.fillStyle = "#888";
  pCtx.font = "bold 9px 'IBM Plex Mono', monospace";
  pCtx.textAlign = "center";
  const now = new Date();
  const ts = `${String(now.getDate()).padStart(2,"0")}.${String(now.getMonth()+1).padStart(2,"0")}.${now.getFullYear()} — #${String(index).padStart(2,"0")}`;
  pCtx.fillText(ts, pc.width / 2, imgH + BORDER + 20);
  return pc;
}

function renderGalleryThumb(snapshotCanvas, index) {
  const print = document.createElement("div");
  print.className = "print";
  const pc = makePolaroid(snapshotCanvas, index);
  pc.style.width = "100%";
  print.appendChild(pc);
  galleryStrip.insertBefore(print, galleryStrip.firstChild);
}

function resetPuzzleOnly() {
  puzzle.boardBox = null;
  puzzle.pieces = [];
  puzzle.solved = false;
  puzzle.solvedAt = null;
  puzzle.fullPhotoboothCanvas = null;
  appState = "tracking";
  countdown.active = false;
  drag.activeHand = null;
  drag.piece = null;
  shatter.active = false;
  shatter.fragments = [];
  shatter.pendingCanvas = null;
  fistHoldCounter = 0;
  lastSeenFrame.box = null;
  lastSeenFrame.at = 0;
  lastCountdownN = -1;
  stopRecording();
  recIndicator.classList.add("hidden");
  updateProgressBadge();
}

function fitCanvasToWindow() {
  const stageEl = document.getElementById("stage");
  const vw = stageEl.clientWidth;
  const vh = stageEl.clientHeight;
  const videoAspect = canvas.width / canvas.height;
  const containerAspect = vw / vh;
  let cssWidth, cssHeight;
  if (containerAspect > videoAspect) {
    cssWidth = vw;
    cssHeight = vw / videoAspect;
  } else {
    cssHeight = vh;
    cssWidth = vh * videoAspect;
  }
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
}

window.addEventListener("resize", fitCanvasToWindow);

async function initWebcam() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support getUserMedia.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    audio: false,
  });
  videoEl.srcObject = stream;
  await new Promise((resolve) => {
    videoEl.onloadedmetadata = () => {
      videoEl.play();
      resolve();
    };
  });
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  fitCanvasToWindow();
}

function withTimeout(promise, ms, timeoutMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function initHandLandmarker() {
  let vision;
  try {
    vision = await withTimeout(
      FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      ),
      LOAD_TIMEOUT_MS,
      "Timed out loading MediaPipe WASM runtime. Check your internet connection."
    );
  } catch (err) {
    throw err;
  }
  try {
    const handLandmarker = await withTimeout(
      HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "video",
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      }),
      LOAD_TIMEOUT_MS,
      "Timed out downloading HandLandmarker model (~10MB) with GPU."
    );
    return handLandmarker;
  } catch (gpuErr) {
    console.warn("[PuzzleCam] GPU delegate failed, retrying with CPU…", gpuErr);
  }
  try {
    const handLandmarker = await withTimeout(
      HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "CPU",
        },
        runningMode: "video",
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      }),
      LOAD_TIMEOUT_MS,
      "Timed out downloading HandLandmarker model even with CPU. Check your connection."
    );
    return handLandmarker;
  } catch (cpuErr) {
    throw cpuErr;
  }
}

function dist2D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function isPinching(landmarks) {
  return dist2D(landmarks[LM.THUMB_TIP], landmarks[LM.INDEX_TIP]) < PINCH_THRESHOLD;
}

function isFist(landmarks) {
  const wrist = landmarks[LM.WRIST];
  const pairs = [
    [LM.INDEX_TIP, LM.INDEX_MCP],
    [LM.MIDDLE_TIP, LM.MIDDLE_MCP],
    [LM.RING_TIP, LM.RING_MCP],
    [LM.PINKY_TIP, LM.PINKY_MCP],
  ];
  let curled = 0;
  for (const [tipIdx, mcpIdx] of pairs) {
    if (dist2D(landmarks[tipIdx], wrist) < dist2D(landmarks[mcpIdx], wrist)) curled++;
  }
  return curled >= 4;
}

function toPixel(landmarkNorm) {
  return { x: landmarkNorm.x * canvas.width, y: landmarkNorm.y * canvas.height };
}

function mirrorLandmarkX(landmark) {
  return { x: 1 - landmark.x, y: landmark.y };
}

function computeHandFrame(indexTipA, indexTipB) {
  const a = toPixel(indexTipA);
  const b = toPixel(indexTipB);
  const minX = Math.min(a.x, b.x) - FRAME_PADDING;
  const maxX = Math.max(a.x, b.x) + FRAME_PADDING;
  const minY = Math.min(a.y, b.y) - FRAME_PADDING;
  const maxY = Math.max(a.y, b.y) + FRAME_PADDING;
  const x = Math.max(0, minX);
  const y = Math.max(0, minY);
  const width = Math.min(canvas.width, maxX) - x;
  const height = Math.min(canvas.height, maxY) - y;
  return { x, y, width, height };
}

const freezeGate = { holding: false, since: 0 };
const FRAME_GRACE_MS = 450;
const lastSeenFrame = { box: null, at: 0 };
const countdown = { active: false, startedAt: 0 };
let lastCountdownN = -1;

function startCountdown(frameBox) {
  puzzle.boardBox = { ...frameBox };
  appState = "countdown";
  countdown.active = true;
  countdown.startedAt = performance.now();
  lastCountdownN = -1;
}

function drawCountdownOverlay(box) {
  const elapsed = (performance.now() - countdown.startedAt) / 1000;
  const remaining = COUNTDOWN_SECONDS - elapsed;

  if (remaining <= 0) {
    finishCountdownAndCapture(box);
    return;
  }

  applyColorInsideBox(box);

  ctx.save();
  ctx.strokeStyle = "#f5c518";
  ctx.lineWidth = 3;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  const n = Math.ceil(remaining);
  if (n !== lastCountdownN) {
    lastCountdownN = n;
    soundCountdownBeep(n);
  }

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  ctx.fillStyle = "rgba(10,10,8,0.45)";
  ctx.fillRect(box.x, box.y, box.width, box.height);

  ctx.font = `${Math.max(48, Math.min(box.width, box.height) * 0.4)}px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = "#f5c518";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(n), cx, cy);
  ctx.restore();

  statusText.textContent = `capturing in ${n}…`;
}

function gaussianNoise(std) {
  const u1 = Math.random() || 1e-6;
  const u2 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return z0 * std;
}

function applyPhotoboothEffect(imageData, bw = false) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const noise = gaussianNoise(PHOTOBOOTH_NOISE_STD);
    if (bw) {
      const gray = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
      const v = Math.max(0, Math.min(255, gray * PHOTOBOOTH_CONTRAST_ALPHA + PHOTOBOOTH_BRIGHTNESS_BETA + noise));
      d[i] = d[i+1] = d[i+2] = v;
    } else {
      d[i]   = Math.max(0, Math.min(255, d[i]   * PHOTOBOOTH_CONTRAST_ALPHA + PHOTOBOOTH_BRIGHTNESS_BETA + noise));
      d[i+1] = Math.max(0, Math.min(255, d[i+1] * PHOTOBOOTH_CONTRAST_ALPHA + PHOTOBOOTH_BRIGHTNESS_BETA + noise));
      d[i+2] = Math.max(0, Math.min(255, d[i+2] * PHOTOBOOTH_CONTRAST_ALPHA + PHOTOBOOTH_BRIGHTNESS_BETA + noise));
    }
  }
  return imageData;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function finishCountdownAndCapture(box) {
  countdown.active = false;

  const mirroredFrame = document.createElement("canvas");
  mirroredFrame.width = canvas.width;
  mirroredFrame.height = canvas.height;
  const mirroredCtx = mirroredFrame.getContext("2d");
  mirroredCtx.save();
  mirroredCtx.translate(mirroredFrame.width, 0);
  mirroredCtx.scale(-1, 1);
  mirroredCtx.drawImage(videoEl, 0, 0, mirroredFrame.width, mirroredFrame.height);
  mirroredCtx.restore();

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = Math.max(1, Math.round(box.width));
  cropCanvas.height = Math.max(1, Math.round(box.height));
  const cropCtx = cropCanvas.getContext("2d");
  cropCtx.drawImage(mirroredFrame, box.x, box.y, box.width, box.height, 0, 0, cropCanvas.width, cropCanvas.height);

  triggerFlash();

  // color version — saved to strip at the end
  const colorImageData = cropCtx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);
  applyPhotoboothEffect(colorImageData, false);
  const colorCanvas = document.createElement("canvas");
  colorCanvas.width = cropCanvas.width;
  colorCanvas.height = cropCanvas.height;
  colorCanvas.getContext("2d").putImageData(colorImageData, 0, 0);
  applyVignette(colorCanvas);

  // B&W version — used for puzzle pieces while solving
  const bwImageData = cropCtx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);
  applyPhotoboothEffect(bwImageData, true);
  cropCtx.putImageData(bwImageData, 0, 0);
  applyVignette(cropCanvas);

  puzzle.fullPhotoboothCanvas = colorCanvas;

  const tileW = Math.floor(cropCanvas.width / GRID);
  const tileH = Math.floor(cropCanvas.height / GRID);
  const pieces = [];

  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const sx = col * tileW;
      const sy = row * tileH;
      const w = col === GRID - 1 ? cropCanvas.width - sx : tileW;
      const h = row === GRID - 1 ? cropCanvas.height - sy : tileH;
      const pieceCanvas = document.createElement("canvas");
      pieceCanvas.width = w;
      pieceCanvas.height = h;
      pieceCanvas.getContext("2d").drawImage(cropCanvas, sx, sy, w, h, 0, 0, w, h);
      pieces.push({ row, col, canvas: pieceCanvas, w, h, x: 0, y: 0, placed: false, dragging: false });
    }
  }

  const slots = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      slots.push({ x: box.x + col * tileW, y: box.y + row * tileH });
    }
  }
  shuffle(slots);

  pieces.forEach((piece, i) => {
    piece.x = slots[i].x;
    piece.y = slots[i].y;
    if (isNearOwnCell(piece, box, tileW, tileH)) snapPieceToCell(piece, box, tileW, tileH);
  });

  puzzle.boardBox = box;
  puzzle.pieces = pieces;
  puzzle.tileW = tileW;
  puzzle.tileH = tileH;
  puzzle.solved = pieces.every((p) => p.placed);
  appState = "puzzle";
  fistHoldCounter = 0;
  updateProgressBadge();
  playTone({ freq: 220, type: "sine", gain: 0.15, attack: 0.001, decay: 0.08, duration: 0.1 });
  startRecording();
}

const drag = { activeHand: null, piece: null, offsetX: 0, offsetY: 0 };

function isNearOwnCell(piece, box, tileW, tileH) {
  const correctX = box.x + piece.col * tileW;
  const correctY = box.y + piece.row * tileH;
  const dx = piece.x - correctX;
  const dy = piece.y - correctY;
  const tolerance = Math.min(tileW, tileH) * SNAP_DISTANCE_RATIO;
  return Math.sqrt(dx * dx + dy * dy) < tolerance;
}

function reconcilePlacedState(box, tileW, tileH) {
  if (!box || !puzzle.pieces.length) return false;
  for (const piece of puzzle.pieces) {
    if (piece.displacing || piece.dragging) continue;
    piece.placed = isNearOwnCell(piece, box, tileW, tileH);
  }
  return puzzle.pieces.every((p) => p.placed);
}

function snapPieceToCell(piece, box, tileW, tileH) {
  displaceCellOccupant(piece, piece.row, piece.col, box, tileW, tileH);
  piece.x = box.x + piece.col * tileW;
  piece.y = box.y + piece.row * tileH;
  piece.placed = true;
}

function displaceCellOccupant(piece, targetRow, targetCol, box, tileW, tileH) {
  const cellX = box.x + targetCol * tileW;
  const cellY = box.y + targetRow * tileH;
  const occupant = puzzle.pieces.find((p) => {
    if (p === piece || p.displacing) return false;
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    return cx >= cellX && cx < cellX + tileW && cy >= cellY && cy < cellY + tileH;
  });
  if (!occupant) return;
  if (occupant.row === targetRow && occupant.col === targetCol && occupant.placed) return;
  occupant.placed = false;
  const freeCells = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      if (row === targetRow && col === targetCol) continue;
      const cx0 = box.x + col * tileW;
      const cy0 = box.y + row * tileH;
      const taken = puzzle.pieces.some((p) => {
        if (p === occupant || p === piece || p.displacing) return false;
        const cx = p.x + p.w / 2;
        const cy = p.y + p.h / 2;
        return cx >= cx0 && cx < cx0 + tileW && cy >= cy0 && cy < cy0 + tileH;
      });
      if (!taken) freeCells.push({ row, col });
    }
  }
  let targetSlot = freeCells.length > 0
    ? freeCells[Math.floor(Math.random() * freeCells.length)]
    : { row: occupant.row, col: occupant.col };
  const jitterX = (Math.random() - 0.5) * tileW * 0.5;
  const jitterY = (Math.random() - 0.5) * tileH * 0.5;
  animateDisplacement(occupant, box.x + targetSlot.col * tileW + jitterX, box.y + targetSlot.row * tileH + jitterY, box);
}

const DISPLACE_ANIM_MS = 220;

function animateDisplacement(piece, targetX, targetY, box) {
  const startX = piece.x;
  const startY = piece.y;
  const startedAt = performance.now();
  piece.displacing = true;
  function step() {
    const t = Math.min(1, (performance.now() - startedAt) / DISPLACE_ANIM_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    piece.x = startX + (targetX - startX) * eased;
    piece.y = startY + (targetY - startY) * eased;
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      piece.x = targetX;
      piece.y = targetY;
      piece.displacing = false;
      clampPieceToBoard(piece);
    }
  }
  requestAnimationFrame(step);
}

function findNearestPiece(px, py) {
  let best = null;
  let bestDist = Infinity;
  for (const piece of puzzle.pieces) {
    if (piece.displacing) continue;
    const cx = piece.x + piece.w / 2;
    const cy = piece.y + piece.h / 2;
    const d = Math.hypot(px - cx, py - cy);
    if (d < Math.max(piece.w, piece.h) * 0.75 && d < bestDist) {
      best = piece;
      bestDist = d;
    }
  }
  return best;
}

function handleDragForHand(handLabel, pinching, indexPx) {
  if (pinching) {
    if (drag.activeHand === null) {
      const candidate = findNearestPiece(indexPx.x, indexPx.y);
      if (candidate) {
        drag.activeHand = handLabel;
        drag.piece = candidate;
        drag.offsetX = indexPx.x - candidate.x;
        drag.offsetY = indexPx.y - candidate.y;
        candidate.dragging = true;
        candidate.placed = false;
      }
    } else if (drag.activeHand === handLabel && drag.piece) {
      drag.piece.x = indexPx.x - drag.offsetX;
      drag.piece.y = indexPx.y - drag.offsetY;
    }
  } else {
    if (drag.activeHand === handLabel && drag.piece) {
      const piece = drag.piece;
      piece.dragging = false;
      if (isNearOwnCell(piece, puzzle.boardBox, puzzle.tileW, puzzle.tileH)) {
        snapPieceToCell(piece, puzzle.boardBox, puzzle.tileW, puzzle.tileH);
      } else {
        clampPieceToBoard(piece);
        const box = puzzle.boardBox;
        const cx = piece.x + piece.w / 2;
        const cy = piece.y + piece.h / 2;
        const dropCol = Math.min(GRID - 1, Math.max(0, Math.floor((cx - box.x) / puzzle.tileW)));
        const dropRow = Math.min(GRID - 1, Math.max(0, Math.floor((cy - box.y) / puzzle.tileH)));
        displaceCellOccupant(piece, dropRow, dropCol, box, puzzle.tileW, puzzle.tileH);
      }
      drag.activeHand = null;
      const wasSolved = puzzle.solved;
      drag.piece = null;
      puzzle.solved = reconcilePlacedState(puzzle.boardBox, puzzle.tileW, puzzle.tileH);
      if (piece.placed) soundSnap();
      if (!wasSolved && puzzle.solved) soundComplete();
      updateProgressBadge();
    }
  }
}

function clampPieceToBoard(piece) {
  const box = puzzle.boardBox;
  piece.x = Math.min(Math.max(piece.x, box.x), box.x + box.width - piece.w);
  piece.y = Math.min(Math.max(piece.y, box.y), box.y + box.height - piece.h);
}

function drawBoardAndPieces() {
  const box = puzzle.boardBox;
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = "rgba(245,197,24,0.18)";
  ctx.lineWidth = 1;
  for (let i = 1; i < GRID; i++) {
    ctx.beginPath();
    ctx.moveTo(box.x + i * puzzle.tileW, box.y);
    ctx.lineTo(box.x + i * puzzle.tileW, box.y + box.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(box.x, box.y + i * puzzle.tileH);
    ctx.lineTo(box.x + box.width, box.y + i * puzzle.tileH);
    ctx.stroke();
  }
  ctx.restore();
  const sorted = [...puzzle.pieces].sort((a, b) => (a.dragging ? 1 : 0) - (b.dragging ? 1 : 0));
  for (const piece of sorted) {
    ctx.save();
    if (piece.dragging) { ctx.shadowColor = "rgba(245,197,24,0.9)"; ctx.shadowBlur = 14; }
    ctx.drawImage(piece.canvas, piece.x, piece.y, piece.w, piece.h);
    ctx.strokeStyle = piece.placed ? "#5fae6e" : "rgba(234,229,214,0.5)";
    ctx.lineWidth = piece.dragging ? 3 : 1.5;
    ctx.strokeRect(piece.x, piece.y, piece.w, piece.h);
    ctx.restore();
  }
  ctx.save();
  ctx.strokeStyle = puzzle.solved ? "#5fae6e" : "#f5c518";
  ctx.lineWidth = 3;
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.restore();
  if (puzzle.solved) {
    ctx.save();
    ctx.fillStyle = "rgba(95,174,110,0.15)";
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.font = `${Math.max(20, box.width * 0.07)}px 'IBM Plex Mono', monospace`;
    ctx.fillStyle = "#5fae6e";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("COMPLETE! — fist to save", box.x + box.width / 2, box.y + box.height / 2);
    ctx.restore();
  }
}

function updateProgressBadge() {
  if (appState !== "puzzle") { progressBadge.classList.remove("visible", "solved"); return; }
  const placedCount = puzzle.pieces.filter((p) => p.placed).length;
  progressText.textContent = `${placedCount} / ${puzzle.pieces.length} pieces placed`;
  progressBadge.classList.add("visible");
  progressBadge.classList.toggle("solved", puzzle.solved);
}

function drawVideoFrame() {
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

function applyColorInsideBox(box) {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.min(canvas.width - x, Math.round(box.width));
  const h = Math.min(canvas.height - y, Math.round(box.height));
  if (w <= 0 || h <= 0) return;
  const region = ctx.getImageData(x, y, w, h);
  applyPhotoboothEffect(region);
  ctx.putImageData(region, x, y);
}

function drawLiveFrameOverlay(box) {
  ctx.save();
  ctx.strokeStyle = "#f5c518";
  ctx.lineWidth = 3;
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  const cornerLen = 18;
  ctx.lineWidth = 4;
  const corners = [
    [box.x, box.y, 1, 1],
    [box.x + box.width, box.y, -1, 1],
    [box.x, box.y + box.height, 1, -1],
    [box.x + box.width, box.y + box.height, -1, -1],
  ];
  for (const [cx, cy, dx, dy] of corners) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + cornerLen * dy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + cornerLen * dx, cy);
    ctx.stroke();
  }
  ctx.restore();
}

function isPointInBoard(px, py, box) {
  if (!box) return false;
  return px >= box.x && px <= box.x + box.width && py >= box.y && py <= box.y + box.height;
}

function drawHandSkeleton(landmarksPx) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(255,255,255,0.85)";
  ctx.shadowBlur = 10;
  ctx.strokeStyle = "white";
  ctx.lineWidth = 3;
  for (const [iA, iB] of HAND_CONNECTIONS) {
    const a = landmarksPx[iA];
    const b = landmarksPx[iB];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.shadowBlur = 6;
  ctx.fillStyle = "white";
  for (const p of landmarksPx) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawHandSkeletonsOverBoard(handsLandmarks, box) {
  if (!box || !handsLandmarks || handsLandmarks.length === 0) return;
  for (const lm of handsLandmarks) {
    const landmarksPx = lm.map((pt) => toPixel(mirrorLandmarkX(pt)));
    const overBoard = landmarksPx.some((p) => isPointInBoard(p.x, p.y, box));
    if (overBoard) drawHandSkeleton(landmarksPx);
  }
}

function startShatter(sourceCanvas, box) {
  const cols = SHATTER_COLS;
  const rows = SHATTER_ROWS;
  const fragW = sourceCanvas.width / cols;
  const fragH = sourceCanvas.height / rows;
  const fragments = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sx = col * fragW;
      const sy = row * fragH;
      const fragCanvas = document.createElement("canvas");
      fragCanvas.width = Math.ceil(fragW);
      fragCanvas.height = Math.ceil(fragH);
      fragCanvas.getContext("2d").drawImage(sourceCanvas, sx, sy, fragW, fragH, 0, 0, fragCanvas.width, fragCanvas.height);
      const cx = box.x + sx + fragW / 2;
      const cy = box.y + sy + fragH / 2;
      const boardCx = box.x + box.width / 2;
      const boardCy = box.y + box.height / 2;
      const dirX = cx - boardCx;
      const dirY = cy - boardCy;
      const dirLen = Math.max(1, Math.hypot(dirX, dirY));
      const speed = 90 + Math.random() * 160;
      fragments.push({
        canvas: fragCanvas, x: cx, y: cy, w: fragW, h: fragH,
        vx: (dirX / dirLen) * speed + (Math.random() - 0.5) * 40,
        vy: (dirY / dirLen) * speed + (Math.random() - 0.5) * 40 - 60,
        rotation: 0,
        rotationSpeed: (Math.random() - 0.5) * 6,
        gravity: 220 + Math.random() * 80,
      });
    }
  }
  shatter.fragments = fragments;
  shatter.active = true;
  shatter.startedAt = performance.now();
  appState = "shattering";
  soundShatter();
  stopRecording();
}

function updateAndDrawShatter() {
  const elapsedMs = performance.now() - shatter.startedAt;
  const t = Math.min(1, elapsedMs / SHATTER_DURATION_MS);
  if (t >= 1) { finishShatter(); return; }
  const dt = 1 / 60;
  const fadeStart = 0.45;
  ctx.save();
  for (const frag of shatter.fragments) {
    frag.x += frag.vx * dt;
    frag.y += frag.vy * dt;
    frag.vy += frag.gravity * dt;
    frag.rotation += frag.rotationSpeed * dt;
    const alpha = t < fadeStart ? 1 : Math.max(0, 1 - (t - fadeStart) / (1 - fadeStart));
    const scale = 1 - t * 0.25;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(frag.x, frag.y);
    ctx.rotate(frag.rotation);
    ctx.scale(scale, scale);
    ctx.drawImage(frag.canvas, -frag.w / 2, -frag.h / 2, frag.w, frag.h);
    ctx.restore();
  }
  ctx.restore();
}

function finishShatter() {
  shatter.active = false;
  shatter.fragments = [];
  if (shatter.pendingCanvas) {
    addToGallery(shatter.pendingCanvas);
    statusText.textContent = "saved to strip!";
    shatter.pendingCanvas = null;
    soundSaved();
  }
  resetPuzzleOnly();
}

function handleFistReset() {
  if (appState !== "puzzle") {
    statusText.textContent = "reset (fist)";
    resetPuzzleOnly();
    return;
  }
  const reallySolved = reconcilePlacedState(puzzle.boardBox, puzzle.tileW, puzzle.tileH);
  puzzle.solved = reallySolved;
  if (reallySolved && puzzle.fullPhotoboothCanvas) {
    shatter.pendingCanvas = puzzle.fullPhotoboothCanvas;
    startShatter(puzzle.fullPhotoboothCanvas, puzzle.boardBox);
  } else {
    statusText.textContent = "reset (fist)";
    resetPuzzleOnly();
  }
}

function checkPuzzleSolvedAndAutoSave() {
  if (puzzle.solved) {
    if (!puzzle.solvedAt) {
      puzzle.solvedAt = performance.now();
    }
    const elapsed = performance.now() - puzzle.solvedAt;
    statusText.textContent = "puzzle complete! saving…";
    if (elapsed >= 1000) {
      puzzle.solvedAt = null;
      if (puzzle.fullPhotoboothCanvas) {
        shatter.pendingCanvas = puzzle.fullPhotoboothCanvas;
        startShatter(puzzle.fullPhotoboothCanvas, puzzle.boardBox);
      }
    }
  } else {
    puzzle.solvedAt = null;
    statusText.textContent = "arrange the puzzle with pinch";
  }
}

let handLandmarker = null;
let fistHoldCounter = 0;

function processResults(result) {
  if (appState === "shattering") {
    updateAndDrawShatter();
    statusText.textContent = "saving…";
    return;
  }

  const handsLandmarks = result.landmarks || [];
  const noHands = handsLandmarks.length === 0;

  if (noHands) {
    statusDot.className = puzzle.solved ? "status-dot solved" : "status-dot";
    fistHoldCounter = 0;
    freezeGate.holding = false;
    if (drag.activeHand && drag.piece) handleDragForHand(drag.activeHand, false, { x: drag.piece.x, y: drag.piece.y });
    if (appState === "tracking") {
      const sinceLastSeen = performance.now() - lastSeenFrame.at;
      if (lastSeenFrame.box && sinceLastSeen < FRAME_GRACE_MS) {
        applyColorInsideBox(lastSeenFrame.box);
        drawLiveFrameOverlay(lastSeenFrame.box);
      }
      statusText.textContent = isStripFull() ? "strip complete — download or reset" : "looking for hands…";
      return;
    }
    if (appState === "countdown") { drawCountdownOverlay(puzzle.boardBox); return; }
    if (appState === "puzzle") {
      puzzle.solved = reconcilePlacedState(puzzle.boardBox, puzzle.tileW, puzzle.tileH);
      updateProgressBadge();
      drawBoardAndPieces();
      checkPuzzleSolvedAndAutoSave();
      return;
    }
    return;
  }

  statusDot.className = puzzle.solved ? "status-dot solved" : "status-dot live";

  const anyFist = handsLandmarks.some((lm) => isFist(lm));
  const draggingNow = drag.activeHand !== null && drag.piece !== null;
  if (anyFist && !draggingNow && appState !== "tracking") {
    fistHoldCounter++;
    if (fistHoldCounter >= FIST_HOLD_FRAMES) { fistHoldCounter = 0; handleFistReset(); return; }
  } else {
    fistHoldCounter = 0;
  }

  if (appState === "tracking") {
    if (isStripFull()) { statusText.textContent = "strip complete — download or reset"; return; }
    if (handsLandmarks.length === 2) {
      const [handA, handB] = handsLandmarks;
      const indexA = mirrorLandmarkX(handA[LM.INDEX_TIP]);
      const indexB = mirrorLandmarkX(handB[LM.INDEX_TIP]);
      const frameBox = computeHandFrame(indexA, indexB);
      if (frameBox.width > 4 && frameBox.height > 4) {
        applyColorInsideBox(frameBox);
        drawLiveFrameOverlay(frameBox);
        lastSeenFrame.box = frameBox;
        lastSeenFrame.at = performance.now();
      }
      const bothPinching = isPinching(handA) && isPinching(handB);
      if (bothPinching && frameBox.width > 40 && frameBox.height > 40) {
        if (!freezeGate.holding) { freezeGate.holding = true; freezeGate.since = performance.now(); }
        statusDot.className = "status-dot armed";
        statusText.textContent = "hold the pinch…";
        if (performance.now() - freezeGate.since > FREEZE_HOLD_MS) { freezeGate.holding = false; startCountdown(frameBox); }
      } else {
        freezeGate.holding = false;
        statusText.textContent = "hands tracking";
      }
    } else {
      freezeGate.holding = false;
      const sinceLastSeen = performance.now() - lastSeenFrame.at;
      if (lastSeenFrame.box && sinceLastSeen < FRAME_GRACE_MS) {
        applyColorInsideBox(lastSeenFrame.box);
        drawLiveFrameOverlay(lastSeenFrame.box);
      }
      statusText.textContent = "hands tracking";
    }
    return;
  }

  if (appState === "countdown") { drawCountdownOverlay(puzzle.boardBox); return; }

  if (appState === "puzzle") {
    const labelsPresent = new Set();
    handsLandmarks.forEach((lm, i) => {
      const label = i === 0 ? "A" : "B";
      labelsPresent.add(label);
      const pinching = isPinching(lm);
      const indexPx = toPixel(mirrorLandmarkX(lm[LM.INDEX_TIP]));
      handleDragForHand(label, pinching, indexPx);
    });
    if (drag.activeHand && !labelsPresent.has(drag.activeHand) && drag.piece) {
      handleDragForHand(drag.activeHand, false, { x: drag.piece.x, y: drag.piece.y });
    }
    if (!drag.piece) {
      puzzle.solved = reconcilePlacedState(puzzle.boardBox, puzzle.tileW, puzzle.tileH);
      updateProgressBadge();
    }
    drawBoardAndPieces();
    drawHandSkeletonsOverBoard(handsLandmarks, puzzle.boardBox);
    checkPuzzleSolvedAndAutoSave();
  }
}

function renderLoop() {
  if (videoEl.readyState >= 2 && handLandmarker) {
    drawVideoFrame();
    const nowMs = performance.now();
    const result = handLandmarker.detectForVideo(videoEl, nowMs);
    processResults(result);
  }
  requestAnimationFrame(renderLoop);
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.style.display = "block";
}

function showLoaderError(message) {
  loaderText.textContent = message;
  loaderText.style.color = "#e0533d";
  loaderRetry.classList.remove("hidden");
}

function resetLoaderUI() {
  loadingOverlay.classList.remove("hidden");
  loaderText.style.color = "";
  loaderText.textContent = "loading HandLandmarker model…";
  loaderRetry.classList.add("hidden");
  errorBanner.style.display = "none";
}

async function boot() {
  resetLoaderUI();
  let settled = false;
  const watchdogMs = (LOAD_TIMEOUT_MS * 2) + 5000;
  const watchdog = setTimeout(() => {
    if (!settled) showLoaderError("Loading is taking too long. Click retry or check your connection.");
  }, watchdogMs);
  try {
    if (!videoEl.srcObject) await initWebcam();
    handLandmarker = await initHandLandmarker();
    settled = true;
    clearTimeout(watchdog);
    loadingOverlay.classList.add("hidden");
    statusText.textContent = "ready";
    requestAnimationFrame(renderLoop);
  } catch (err) {
    settled = true;
    clearTimeout(watchdog);
    if (err && err.name === "NotAllowedError") {
      showLoaderError("Camera permission denied. Enable it in browser settings and click retry.");
    } else if (err && err.name === "NotFoundError") {
      showLoaderError("No webcam found.");
    } else {
      showLoaderError((err && err.message) || "Error starting the app.");
    }
  }
}

loaderRetry.addEventListener("click", () => { boot(); });

if (downloadStripBtn) {
  updateStripDownloadAvailability();
}

if (downloadVideoBtn) {
  downloadVideoBtn.addEventListener("click", downloadVideo);
}

if (downloadStripBtn) {
  downloadStripBtn.addEventListener("click", showStripModal);
}

if (stripModalDownload) {
  stripModalDownload.addEventListener("click", () => {
    downloadPhotoStrip();
  });
}

if (stripModalClose) {
  stripModalClose.addEventListener("click", () => {
    stripModal.classList.add("hidden");
  });
}

if (resetAllBtn) {
  resetAllBtn.addEventListener("click", () => {
    const confirmed = window.confirm("Are you sure you want to delete the entire photo strip and start over?");
    if (confirmed) resetEverything();
  });
}

boot();
