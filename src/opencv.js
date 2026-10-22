const OPENCV_TIMEOUT_MS = 120000

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
  return new Promise((resolve, reject) => {
    let settled = false
    let hooked = false

    const settle = (error) => {
      if (settled) return
      settled = true
      window.clearInterval(pollId)
      window.clearTimeout(timeoutId)
      if (error) reject(error)
      else resolve()
    }

    const inspect = () => {
      if (settled || hooked) return

      if (window.__opencvLoadError) {
        settle(fail('OpenCV.js 加载失败'))
        return
      }

      const cv = globalThis.cv
      if (!cv) return

      if (typeof cv.Mat === 'function') {
        settle()
        return
      }

      if (typeof cv.then === 'function') {
        hooked = true
        cv.then(() => {
          settle()
        })
        return
      }

      hooked = true
      const previous = cv.onRuntimeInitialized
      cv.onRuntimeInitialized = () => {
        if (typeof previous === 'function') previous()
        settle()
      }
    }

    const pollId = window.setInterval(inspect, 50)
    const timeoutId = window.setTimeout(() => {
      settle(fail('OpenCV.js 加载超时'))
    }, timeoutMs)

    const script = document.querySelector('script[src*="opencv.js"]')
    if (script) {
      script.addEventListener('error', () => {
        settle(fail('OpenCV.js 加载失败'))
      })
    }

    inspect()
  })
}
