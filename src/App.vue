<template>
  <main class="page">
    <h1>拍照</h1>
    <p class="status" :data-state="status">{{ statusText }}</p>
    <p v-if="status === 'error'" class="error">{{ loadError }}</p>
    <p v-if="status === 'ready'" class="time">OpenCV 加载时间：{{ loadTime.toFixed(0) }}ms</p>

    <label class="pick">
      拍照或从相册选择
      <input
        type="file"
        accept="image/*"
        capture="environment"
        :disabled="status !== 'ready'"
        @change="onPick"
      />
    </label>

    <p v-if="processError" class="error">{{ processError }}</p>
    <p v-if="matInfo" class="mat">
      宽 {{ matInfo.width }} · 高 {{ matInfo.height }} · 通道 {{ matInfo.channels }}
    </p>
    <p v-else-if="status === 'ready'" class="hint">选择一张照片后，这里会显示 Mat 的尺寸。</p>

    <canvas v-show="matInfo" ref="canvasEl" class="preview"></canvas>
  </main>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { waitForOpencv } from './opencv.js'

const status = ref('loading')
const loadError = ref('')
const imageUrl = ref('')
const matInfo = ref(null)
const processError = ref('')
const canvasEl = ref(null)
const cvRef = shallowRef(null)

const statusText = computed(() => {
  if (status.value === 'ready') return 'OpenCV 就绪'
  if (status.value === 'error') return '加载失败'
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
  } catch (error) {
    status.value = 'error'
    loadError.value = error instanceof Error ? error.message : 'OpenCV.js 加载失败'
  }
})

onUnmounted(() => {
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
})

function onPick(event) {
  const file = event.target.files && event.target.files[0]
  if (!file || status.value !== 'ready' || !cvRef.value) return

  processError.value = ''
  const url = URL.createObjectURL(file)
  const previous = imageUrl.value
  imageUrl.value = url
  if (previous) URL.revokeObjectURL(previous)

  const img = new Image()
  img.onload = () => {
    try {
      readIntoMat(img)
    } catch (error) {
      matInfo.value = null
      processError.value = error instanceof Error ? error.message : '无法处理这张图片'
    }
  }
  img.onerror = () => {
    matInfo.value = null
    processError.value = '无法读取这张图片'
  }
  img.src = url
}

function readIntoMat(img) {
  const canvas = canvasEl.value
  const cv = cvRef.value
  if (!canvas || !cv) return

  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)

  const mat = cv.imread(canvas)
  try {
    matInfo.value = {
      width: mat.cols,
      height: mat.rows,
      channels: mat.channels(),
    }
    cv.imshow(canvas, mat)
  } finally {
    mat.delete()
  }
}
</script>

<style scoped>
.page {
  box-sizing: border-box;
  max-width: 40rem;
  margin: 0 auto;
  padding: 1.25rem 1rem 2rem;
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

.pick {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-weight: 600;
}

.pick input {
  font: inherit;
}

.mat,
.hint,
.error {
  margin: 1rem 0 0;
  line-height: 1.5;
}

.error {
  color: #a32020;
}

.preview {
  display: block;
  width: 100%;
  height: auto;
  margin-top: 1rem;
  background: #f3f3f3;
}
</style>
