import opencvUrl from '../vendor/opencv.js?url'

const OPENCV_TIMEOUT_MS = 120000

let pending = null

function fail(message) {
  const error = new Error(message)
  error.name = 'OpenCvLoadError'
  return error
}

/**
 * Resolves when the global `cv` namespace has finished WASM startup.
 * The promise fulfills with `undefined` on purpose: `cv` has a `.then` method,
 * and resolving a Promise with it makes the runtime unwrap that thenable forever.
 * Callers should read `globalThis.cv` after this returns.
 */
export function waitForOpencv(timeoutMs = OPENCV_TIMEOUT_MS) {
  if (typeof globalThis.cv?.Mat === 'function') return Promise.resolve()
  if (!pending) {
    pending = loadOpencv(timeoutMs).catch((error) => {
      pending = null
      throw error
    })
  }
  return pending
}

function loadOpencv(timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = 0
    const finish = (error) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    timer = window.setTimeout(() => finish(fail('OpenCV.js 加载超时')), timeoutMs)

    const script = document.createElement('script')
    script.src = opencvUrl
    script.async = true
    script.onload = () => watchRuntime(finish)
    script.onerror = () => finish(fail('OpenCV.js 加载失败'))
    document.head.appendChild(script)
  })
}

function watchRuntime(finish) {
  const cv = globalThis.cv
  if (!cv) {
    finish(fail('OpenCV.js 加载失败'))
    return
  }
  if (typeof cv.Mat === 'function') {
    finish()
    return
  }
  if (typeof cv.then === 'function') {
    cv.then(() => finish(), () => finish(fail('OpenCV.js 加载失败')))
    return
  }
  const previous = cv.onRuntimeInitialized
  cv.onRuntimeInitialized = () => {
    if (typeof previous === 'function') previous()
    finish()
  }
}
