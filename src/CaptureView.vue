<template>
  <div class="shell">
    <div class="panel">
      <header class="top">
        <button type="button" class="back" aria-label="返回" @click="emit('back')">
          <svg viewBox="0 0 30 30" aria-hidden="true">
            <path d="M6 6l18 18M24 6L6 24" />
          </svg>
        </button>
      </header>

      <div class="stage">
        <div class="frame">
          <video
            ref="videoEl"
            class="preview"
            autoplay
            muted
            playsinline
            disablepictureinpicture
          ></video>
          <div ref="dimEl" class="dim"></div>
          <canvas ref="overlayEl" class="overlay"></canvas>
          <div v-if="flashKey" :key="flashKey" class="flash"></div>
          <p v-if="errorText" class="notice">{{ errorText }}</p>
        </div>
      </div>

      <footer class="bottom">
        <button
          type="button"
          class="shutter"
          :data-mode="shutterMode"
          aria-label="拍照"
          :disabled="shutterMode !== 'ready'"
          @click="capture"
        >
          <svg class="shutter-ring" viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="48" />
          </svg>
          <span :key="flashKey" class="shutter-core" :class="{ 'is-pressed': flashKey }"></span>
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { cameraErrorText, openCamera } from './camera.js'
import { waitForOpencv } from './opencv.js'
import { detectTable } from './table.js'
import { detectSimulatedTable } from './table-sim.js'

const props = defineProps({
  stream: { type: Object, default: null },
})
const emit = defineEmits(['back'])

const TARGET_RATIO = 3 / 4

const videoEl = ref(null)
const dimEl = ref(null)
const overlayEl = ref(null)
const ready = ref(false)
const errorText = ref('')
const flashKey = ref(0)
const capturedFrame = shallowRef(null)
const detectedSides = ref(null)
const simulate = false

const EDGE_COLOR = '#fff'

const canCapture = computed(() => shutterMode.value === 'ready')
const shutterMode = computed(() => {
  if (!ready.value || errorText.value) return 'unavailable'
  if (!detectedSides.value?.length) return 'searching'
  return 'ready'
})

let stream = null
let cameraToken = 0
let alive = true
let overlayFrame = 0
let overlayObserver = null
let shownSides = null
let frameCanvas = null
let frameCtx = null
let presence = 0
let presenceFrom = 0
let presenceTo = 0
let presenceStarted = 0
const pauseReasons = new Set()
let idle = null
let idleResolve = null
const portraitMedia = window.matchMedia('(orientation: portrait)')

const FOCUS_MS = 250
const DIM_AMOUNT = 0.45

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)
  portraitMedia.addEventListener('change', onPortraitChange)
  if (document.hidden) pauseReasons.add('hidden')
  if (!portraitMedia.matches) pauseReasons.add('orientation')

  if (pauseReasons.size > 0) {
    stopStream(props.stream)
  } else if (props.stream) {
    bindStream(props.stream, ++cameraToken)
  } else {
    startCamera()
  }

  const frame = overlayEl.value?.parentElement
  overlayObserver = new ResizeObserver(() => paintSimulation(performance.now()))
  if (frame) overlayObserver.observe(frame)
  overlayFrame = requestAnimationFrame(tickSimulation)
  if (simulate) runDetections()
  else runTableDetections()
})

onBeforeUnmount(() => {
  alive = false
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('pagehide', onPageHide)
  window.removeEventListener('pageshow', onPageShow)
  portraitMedia.removeEventListener('change', onPortraitChange)
  idleResolve?.()
  cancelAnimationFrame(overlayFrame)
  overlayObserver?.disconnect()
  stopCamera()
})

async function startCamera() {
  const token = ++cameraToken
  errorText.value = ''
  try {
    const next = await openCamera()
    if (!alive || token !== cameraToken || pauseReasons.size > 0) {
      stopStream(next)
      return
    }
    await bindStream(next, token)
  } catch (error) {
    if (!alive || token !== cameraToken) return
    stopCamera()
    ready.value = false
    errorText.value = cameraErrorText(error)
  }
}

async function bindStream(next, token) {
  const video = videoEl.value
  if (!video) {
    stopStream(next)
    return
  }
  stream = next
  video.muted = true
  video.playsInline = true
  video.srcObject = next
  try {
    await video.play()
  } catch (error) {
    if (!alive || token !== cameraToken) return
    stopCamera()
    ready.value = false
    errorText.value = cameraErrorText(error)
    return
  }
  if (!alive || token !== cameraToken || pauseReasons.size > 0) {
    stopCamera()
    return
  }
  ready.value = true
}

function onVisibility() {
  if (document.hidden) pause('hidden')
  else unpause('hidden')
}

function onPageHide() {
  pause('hidden')
}

function onPageShow() {
  if (!document.hidden) unpause('hidden')
}

function onPortraitChange() {
  if (portraitMedia.matches) unpause('orientation')
  else pause('orientation')
}

function pause(reason) {
  const wasRunning = pauseReasons.size === 0
  pauseReasons.add(reason)
  if (!wasRunning) return
  detectedSides.value = null
  errorText.value = ''
  stopCamera()
}

function unpause(reason) {
  if (!pauseReasons.delete(reason) || pauseReasons.size > 0) return
  idleResolve?.()
  if (alive) startCamera()
}

function waitUntilRunning() {
  if (pauseReasons.size === 0) return Promise.resolve()
  if (!idle) {
    idle = new Promise((resolve) => {
      idleResolve = () => {
        idle = null
        idleResolve = null
        resolve()
      }
    })
  }
  return idle
}

function tickSimulation(time) {
  if (!alive) return
  paintSimulation(time)
  overlayFrame = requestAnimationFrame(tickSimulation)
}

async function runTableDetections() {
  try {
    await waitForOpencv()
  } catch (error) {
    if (!alive) return
    errorText.value = error instanceof Error ? error.message : 'OpenCV 加载失败'
    return
  }

  const cv = globalThis.cv
  while (alive) {
    await waitUntilRunning()
    if (!alive) return
    const video = videoEl.value
    const overlay = overlayEl.value
    if (!ready.value || !video?.videoWidth || !overlay || overlay.width < 2 || overlay.height < 2) {
      await nextFrame()
      continue
    }

    const viewWidth = overlay.width
    const viewHeight = overlay.height
    const crop = visibleCrop(video.videoWidth, video.videoHeight)
    const frame = grabFrame(video, crop)
    if (!frame || frame.width < 2 || frame.height < 2) {
      await nextFrame()
      continue
    }

    let src = null
    try {
      src = cv.imread(frame)
      const sides = detectTable(cv, src)
      const current = overlayEl.value
      if (!alive) return
      if (pauseReasons.size === 0 && current && current.width === viewWidth && current.height === viewHeight) {
        detectedSides.value = sides
          ? scaleSides(sides, viewWidth / frame.width, viewHeight / frame.height)
          : null
      }
    } catch {
      if (!alive) return
    } finally {
      if (src && !src.isDeleted?.()) src.delete()
    }

    // 检测是同步的，让出一帧再抓最新画面，避免调用在主线程上排成一串。
    await nextFrame()
  }
}

function grabFrame(video, crop) {
  const width = Math.max(1, Math.round(crop.sw))
  const height = Math.max(1, Math.round(crop.sh))
  if (!frameCanvas) {
    frameCanvas = document.createElement('canvas')
    frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true })
  }
  if (!frameCtx) return null
  if (frameCanvas.width !== width || frameCanvas.height !== height) {
    frameCanvas.width = width
    frameCanvas.height = height
  }
  frameCtx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height)
  return frameCanvas
}

function scaleSides(sides, scaleX, scaleY) {
  return sides.map((side) => ({
    start: [side.start[0] * scaleX, side.start[1] * scaleY],
    end: [side.end[0] * scaleX, side.end[1] * scaleY],
    kind: side.kind,
  }))
}

async function runDetections() {
  while (alive && simulate) {
    const canvas = overlayEl.value
    if (!canvas || canvas.width < 2 || canvas.height < 2) {
      await nextFrame()
      continue
    }
    const width = canvas.width
    const height = canvas.height
    const result = await detectSimulatedTable(width, height)
    if (!alive) return
    const current = overlayEl.value
    if (!current || current.width !== result.width || current.height !== result.height) continue
    detectedSides.value = result.sides
  }
}

function nextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(resolve)
  })
}

function paintSimulation(time) {
  const canvas = overlayEl.value
  if (!canvas) return
  if (syncOverlaySize(canvas)) detectedSides.value = null
  drawSides(canvas, detectedSides.value, time)
}

function syncOverlaySize(canvas) {
  const frame = canvas.parentElement
  if (!frame) return
  const dpr = window.devicePixelRatio || 1
  const width = Math.max(1, Math.round(frame.clientWidth * dpr))
  const height = Math.max(1, Math.round(frame.clientHeight * dpr))
  if (canvas.width === width && canvas.height === height) return false
  canvas.width = width
  canvas.height = height
  return true
}

function drawSides(canvas, sides, time) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  if (sides?.length) shownSides = sides
  seekPresence(sides?.length ? 1 : 0, time)
  setDim(presence)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (!shownSides?.length || presence <= 0.001) {
    if (!sides?.length) shownSides = null
    return
  }
  const shortSide = Math.min(canvas.width, canvas.height)
  ctx.save()
  ctx.globalAlpha = presence
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.strokeStyle = EDGE_COLOR
  ctx.lineWidth = Math.max(2, shortSide * 0.004)
  for (const side of shownSides) {
    ctx.beginPath()
    ctx.moveTo(side.start[0], side.start[1])
    ctx.lineTo(side.end[0], side.end[1])
    ctx.stroke()
  }
  const corners = quadCorners(shownSides)
  if (corners) drawCornerMarks(ctx, corners, shortSide, 1 - presence)
  ctx.restore()
}

function seekPresence(target, time) {
  if (target !== presenceTo) {
    presenceFrom = presence
    presenceTo = target
    presenceStarted = time
  }
  const delta = presenceTo - presenceFrom
  if (delta === 0) {
    presence = presenceTo
    return
  }
  const progress = Math.min(1, Math.max(0, (time - presenceStarted) / FOCUS_MS))
  presence = presenceFrom + delta * easeOutCubic(progress)
}

function setDim(amount) {
  const el = dimEl.value
  if (!el) return
  el.style.opacity = String(Math.min(1, Math.max(0, amount)) * DIM_AMOUNT)
}

function easeOutCubic(amount) {
  return 1 - (1 - amount) ** 3
}

function quadCorners(sides) {
  const unique = []
  for (const side of sides) {
    for (const point of [side.start, side.end]) {
      const seen = unique.some((item) => Math.hypot(item[0] - point[0], item[1] - point[1]) < 2)
      if (!seen) unique.push(point)
    }
  }
  if (unique.length !== 4) return null
  const cx = unique.reduce((sum, point) => sum + point[0], 0) / 4
  const cy = unique.reduce((sum, point) => sum + point[1], 0) / 4
  unique.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx))
  return unique
}

function drawCornerMarks(ctx, corners, shortSide, move) {
  const cx = corners.reduce((sum, point) => sum + point[0], 0) / 4
  const cy = corners.reduce((sum, point) => sum + point[1], 0) / 4
  ctx.lineWidth = Math.max(4, shortSide * 0.012)
  for (let index = 0; index < corners.length; index += 1) {
    const corner = corners[index]
    const previous = corners[(index + 3) % corners.length]
    const next = corners[(index + 1) % corners.length]
    const ox = corner[0] - cx
    const oy = corner[1] - cy
    const span = Math.hypot(ox, oy) || 1
    const rest = shortSide * 0.028
    const travel = rest + move * shortSide * 0.05
    const x = corner[0] + (ox / span) * travel
    const y = corner[1] + (oy / span) * travel
    const arm = Math.min(span * 0.28, shortSide * 0.07)
    const towardPrevious = unit(corner, previous)
    const towardNext = unit(corner, next)
    ctx.beginPath()
    ctx.moveTo(x + towardPrevious.x * arm, y + towardPrevious.y * arm)
    ctx.lineTo(x, y)
    ctx.lineTo(x + towardNext.x * arm, y + towardNext.y * arm)
    ctx.stroke()
  }
}

function unit(from, to) {
  const x = to[0] - from[0]
  const y = to[1] - from[1]
  const length = Math.hypot(x, y) || 1
  return { x: x / length, y: y / length }
}

function capture() {
  const video = videoEl.value
  if (!canCapture.value || !video?.videoWidth || !video.videoHeight) return

  const crop = visibleCrop(video.videoWidth, video.videoHeight)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(crop.sw)
  canvas.height = Math.round(crop.sh)
  const ctx = canvas.getContext('2d')
  if (!ctx || canvas.width < 1 || canvas.height < 1) return
  ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height)
  capturedFrame.value = canvas
  flashKey.value += 1
}

function visibleCrop(videoWidth, videoHeight) {
  const videoRatio = videoWidth / videoHeight
  if (videoRatio > TARGET_RATIO) {
    const sh = videoHeight
    const sw = sh * TARGET_RATIO
    return { sx: (videoWidth - sw) / 2, sy: 0, sw, sh }
  }
  const sw = videoWidth
  const sh = sw / TARGET_RATIO
  return { sx: 0, sy: (videoHeight - sh) / 2, sw, sh }
}

function stopCamera() {
  cameraToken += 1
  ready.value = false
  stopStream(stream)
  stream = null
  const video = videoEl.value
  if (video) video.srcObject = null
}

function stopStream(target) {
  target?.getTracks().forEach((track) => track.stop())
}
</script>

<style scoped>
.shell {
  box-sizing: border-box;
  height: 100dvh;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto minmax(0, 1.2fr);
  justify-items: center;
  background: var(--black);
  color: var(--white);
  overflow: hidden;
  font-family: system-ui, sans-serif;
}

.panel {
  grid-row: 2;
  box-sizing: border-box;
  width: min(100dvw, calc(100dvh * 9 / 16));
  aspect-ratio: 9 / 16;
  max-height: 100dvh;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.top {
  flex: none;
  display: flex;
  align-items: center;
  height: 2.75rem;
  padding: 0 0.5rem;
}

.back {
  width: 2.75rem;
  height: 2.75rem;
  display: grid;
  place-items: center;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--white);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.back svg {
  width: 1.5rem;
  height: 1.5rem;
}

.back path {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
}

.stage {
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  container-type: size;
}

.frame {
  position: relative;
  width: min(100cqw, calc(100cqh * 3 / 4));
  aspect-ratio: 3 / 4;
  overflow: hidden;
  background: var(--black);
}

.preview,
.overlay {
  display: block;
  width: 100%;
  height: 100%;
}

.preview {
  object-fit: cover;
  background: var(--black);
}

.dim {
  position: absolute;
  inset: 0;
  background: var(--black);
  opacity: 0;
  pointer-events: none;
}

.overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.flash {
  position: absolute;
  inset: 0;
  background: var(--white);
  pointer-events: none;
  animation: shutter-flash 180ms ease-out forwards;
}

.notice {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 1rem;
  text-align: center;
  font-size: 0.95rem;
  font-weight: 600;
  line-height: 1.5;
}

.bottom {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 5.25rem;
  padding: 0.35rem 0 0.6rem;
}

.shutter {
  position: relative;
  width: clamp(4rem, 18vw, 5.25rem);
  height: clamp(4rem, 18vw, 5.25rem);
  min-width: 44px;
  min-height: 44px;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  border: 0;
  border-radius: 50%;
  padding: 0;
  background: transparent;
  cursor: default;
  -webkit-tap-highlight-color: transparent;
}

.shutter[data-mode='ready'] {
  cursor: pointer;
}

.shutter-ring {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.shutter-ring circle {
  fill: none;
  stroke: var(--main);
  stroke-width: 4;

  transition: stroke 180ms ease-in-out;
}

.shutter[data-mode='unavailable'] .shutter-ring circle {
  stroke: var(--white-disabled);
}

.shutter[data-mode='searching'] .shutter-ring {
  animation: shutter-search 0.9s linear infinite;
}

.shutter[data-mode='searching'] .shutter-ring circle {
  stroke: var(--white);
  stroke-linecap: round;
  stroke-dasharray: 220 82;
}

.shutter-core {
  position: relative;
  width: 82%;
  height: 82%;
  border-radius: 50%;
  background: var(--white);

  transition: background-color 180ms ease-in-out;
}

.shutter[data-mode='unavailable'] .shutter-core,
.shutter[data-mode='searching'] .shutter-core {
  background: var(--white-disabled);
}

.shutter-core.is-pressed {
  animation: shutter-core-press 180ms ease-in-out;
}

.shutter:disabled {
  cursor: default;
}

@keyframes shutter-search {
  to {
    transform: rotate(360deg);
  }
}

@keyframes shutter-flash {
  from {
    opacity: 0.9;
  }
  to {
    opacity: 0;
  }
}

@keyframes shutter-core-press {
  0% {
    width: 82%;
    height: 82%;
  }
  15% {
    width: 78%;
    height: 78%;
  }
  100% {
    width: 82%;
    height: 82%;
  }
}
</style>
