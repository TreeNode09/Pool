const DETECT_MS = 100
const CYCLE_MS = 2000
const MISS_MS = 500

export function detectSimulatedTable(width, height, time = performance.now()) {
  const captured = { width, height, time }
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        width: captured.width,
        height: captured.height,
        sides: tableAt(captured.width, captured.height, captured.time),
      })
    }, DETECT_MS)
  })
}

function tableAt(width, height, time) {
  if (time % CYCLE_MS >= CYCLE_MS - MISS_MS) return null
  const wobble = Math.sin(time / 900) * 0.012
  const insetX = 0.14 + wobble
  const topNarrow = 0.08
  const yTop = height * 0.22
  const yBottom = height * (1 - (0.16 - wobble))
  const corners = [
    [width * (insetX + topNarrow), yTop],
    [width * (1 - insetX - topNarrow), yTop],
    [width * (1 - insetX), yBottom],
    [width * insetX, yBottom],
  ]
  return corners.map((start, index) => ({
    start,
    end: corners[(index + 1) % 4],
    kind: 'wood',
  }))
}
