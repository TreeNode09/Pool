<template>
  <main class="page">
    <h1>拍照</h1>
    <p class="status" :data-state="status">{{ statusText }}</p>
    <p v-if="status === 'error'" class="error">{{ loadError }}</p>
    <p v-if="status === 'ready'" class="time">OpenCV 加载时间：{{ loadTime.toFixed(0) }} ms</p>
    <div class="samples">
      <button
        v-for="sample in samples"
        :key="sample.id"
        type="button"
        :disabled="status === 'loading'"
        :data-active="sampleId === sample.id"
        @click="loadSample(sample.id)"
      >
        {{ sample.label }}
      </button>
    </div>
    <div class="samples">
      <button
        v-for="bed in beds"
        :key="bed.id"
        type="button"
        :disabled="status === 'loading'"
        :data-active="bedId === bed.id"
        @click="selectBed(bed.id)"
      >
        {{ bed.label }}
      </button>
    </div>
    <p v-if="detectText" class="time">{{ detectText }}</p>
    <div class="stage">
      <canvas ref="canvasEl" class="preview"></canvas>
      <canvas ref="overlayEl" class="overlay"></canvas>
    </div>
  </main>
</template>

<script setup>
import { computed, onMounted, ref, shallowRef } from 'vue'
import { waitForOpencv } from './opencv.js'
import { detectTable, kindLabel } from './table.js'
import { TABLE_BEDS, solveTablePose } from './pose.js'
import { createTableView } from './table-view.js'

const samples = [
  { id: 'hard', label: '01', src: '/test/01.png' },
  { id: 'easy', label: '02', src: '/test/02.png' },
]

const status = ref('loading')
const loadError = ref('')
const detectText = ref('')
const sampleId = ref('hard')
const bedId = ref('chinese')
const beds = TABLE_BEDS
const canvasEl = ref(null)
const overlayEl = ref(null)
const cvRef = shallowRef(null)

const KIND_COLOR = {
  wood: '#e10600',
  shadow: '#f08a00',
  rough: '#d6b400',
  bed: '#1a73e8',
}

const statusText = computed(() => {
  if (status.value === 'ready') return 'OpenCV 就绪'
  if (status.value === 'error') return cvRef.value ? '检测失败' : '加载失败'
  return '加载中'
})

let startTime = 0
const loadTime = computed(() => {
  return performance.now() - startTime
})

onMounted(async () => {
  startTime = performance.now()
  try {
    await waitForOpencv()
    cvRef.value = globalThis.cv
    status.value = 'ready'
    tableView = createTableView(overlayEl.value)
    loadSample('hard')
  } catch (error) {
    status.value = 'error'
    loadError.value = error instanceof Error ? error.message : 'OpenCV.js 加载失败'
  }
})

let loadToken = 0
let tableView = null
let lastSides = null
let lastSize = null
let lastSummary = ''

function loadSample(id) {
  const sample = samples.find((item) => item.id === id)
  if (!sample) return
  sampleId.value = id
  detectText.value = '检测中'
  const token = ++loadToken
  const img = new Image()
  img.onload = () => {
    if (token !== loadToken) return
    try {
      proceedMat(img)
    } catch (error) {
      status.value = 'error'
      loadError.value = error instanceof Error ? error.message : '无法处理测试图片'
    }
  }
  img.onerror = () => {
    if (token !== loadToken) return
    status.value = 'error'
    detectText.value = ''
    loadError.value = '无法读取测试图片'
  }
  img.src = sample.src
}

function proceedMat(img) {
  const canvas = canvasEl.value
  const cv = cvRef.value
  if (!canvas || !cv) return

  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)

  const src = cv.imread(canvas)
  const started = performance.now()
  try {
    const sides = detectTable(cv, src)
    const elapsed = performance.now() - started
    if (!sides) {
      lastSides = null
      lastSummary = ''
      tableView?.clear()
      detectText.value = '未检测到球桌'
      return
    }
    drawSides(ctx, sides, Math.min(canvas.width, canvas.height))
    lastSides = sides
    lastSize = { width: canvas.width, height: canvas.height }
    lastSummary = `桌面检测 ${elapsed.toFixed(0)} ms · ${sides.map((side) => kindLabel(side.kind)).join(' / ')}`
    status.value = 'ready'
    applyPose()
  } catch (error) {
    status.value = 'error'
    detectText.value = ''
    loadError.value = error instanceof Error ? error.message : '桌面检测失败'
  } finally {
    src.delete()
  }
}

function selectBed(id) {
  bedId.value = id
  applyPose()
}

function applyPose() {
  if (!lastSides || !lastSize || !cvRef.value || !tableView) return
  const bed = beds.find((item) => item.id === bedId.value)
  try {
    const pose = solveTablePose(cvRef.value, lastSides, lastSize.width, lastSize.height, bed)
    if (!pose) {
      tableView.clear()
      detectText.value = `${lastSummary} · 未能估计姿态`
      return
    }
    tableView.show(pose, bed)
    detectText.value = `${lastSummary} · 重投影 ${pose.error.toFixed(1)} px`
  } catch (error) {
    tableView.clear()
    status.value = 'error'
    detectText.value = ''
    loadError.value = error instanceof Error ? error.message : '姿态估计失败'
  }
}

function drawSides(ctx, sides, shortSide) {
  ctx.lineWidth = Math.max(2, shortSide * 0.004)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const side of sides) {
    ctx.beginPath()
    ctx.moveTo(side.start[0], side.start[1])
    ctx.lineTo(side.end[0], side.end[1])
    ctx.strokeStyle = KIND_COLOR[side.kind] ?? '#e10600'
    ctx.stroke()
  }
}
</script>

<style scoped>
.page {
  box-sizing: border-box;
  max-width: 40rem;
  margin: 0 auto;
  padding: 1.25rem 1rem 2rem;
  background: #fff;
  font-family: system-ui, sans-serif;
  color: #1a1a1a;
}

h1 {
  margin: 0 0 0.75rem;
  font-size: 1.5rem;
}

.status {
  margin: 0 0 1rem;
  font-weight: 650;
}

.status[data-state='loading'] {
  color: #8a5a00;
}

.status[data-state='ready'] {
  color: #0b6b32;
}

.status[data-state='error'] {
  color: #a32020;
}

.error {
  margin: 1rem 0 0;
  line-height: 1.5;
  color: #a32020;
}

.time {
  margin: 0 0 0.5rem;
  line-height: 1.5;
}

.samples {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.samples button {
  border: 1px solid #c8c8c8;
  border-radius: 999px;
  padding: 0.3rem 0.8rem;
  background: #fff;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.samples button[data-active='true'] {
  border-color: #0b6b32;
  color: #0b6b32;
  font-weight: 650;
}

.stage {
  position: relative;
  width: 100%;
  margin-top: 0.5rem;
}

.preview,
.overlay {
  display: block;
  width: 100%;
  height: auto;
}

.preview {
  background: #f3f3f3;
}

.overlay {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
