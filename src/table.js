// 从 table.py 移植的台面检测。输入是 cv.imread 得到的 RGBA 图（浏览器里的 RGB 顺序）。
// 返回四条边：{ start: [x, y], end: [x, y], kind: 'wood' | 'shadow' | 'rough' }。

const SAMPLED_SHORT_SIDE = 220

// 实时检测的工作分辨率。短边更长时先缩小，四条边再映射回原图。
// 摄像头严格取 540×720，短边与这里一致。
const DETECT_SHORT_SIDE = 540

const GAUSSIAN_SIGMA_X = 0.2
const GAUSSIAN_SIGMA_Y = 0.2

const SHADOW_THRESHOLD = 50
const HIGHLIGHT_THRESHOLD = 200

const BINARY_THRESHOLD = 0.0001
const REGION_SIZE_THRESHOLD = 0.01

const HUE_RADIUS = 4
const SATURATION_RADIUS = 8

const HUE_BINS = 180
const SATURATION_BINS = 256

const POLY_EPSILON_RATIO = 0.02
const FILL_RATIO_MIN = 0.6

const CENTER_X_MIN = 0.15
const CENTER_X_MAX = 0.85
const CENTER_Y_MIN = 0.3
const CENTER_Y_MAX = 0.9

const CANNY_THRESHOLD_LOW = 50
const CANNY_THRESHOLD_HIGH = 150

const HOUGH_RHO = 1
const HOUGH_ANGLE_STEP = Math.PI / 90
const HOUGH_THRESHOLD = 40
const HOUGH_MIN_LENGTH_RATIO = 0.12
const HOUGH_GAP_RATIO = 0.25

const RAIL_PARALLEL = 0.93
const RAIL_INWARD_RATIO = 0.022
const RAIL_OUTWARD_RATIO = 0.11
const ALONG_SPAN_RATIO = 1

const SIDE_DISTANCE_RATIOS = [0.011, 0.02, 0.028]

const SAMPLE_T_START = 0.2
const SAMPLE_T_END = 0.8
const SAMPLE_COUNT = 8

const CLOTH_HUE_TOLERANCE = 12
const CLOTH_SATURATION_TOLERANCE = 50
const CLOTH_LIGHTNESS_MAX = 230

const LABEL_FRACTION = 0.5
const MIN_SIDE_POINTS = 2

const SHADOW_LIGHTNESS_GAP = 15
const SHADOW_LIGHTNESS_RATIO = 0.85

const MIN_VOTES = 4
const MIN_SUPPORT = 0.6

const CHOSEN_OFFSET_MIN_RATIO = -0.006
const CORNER_MOVE_RATIO = 0.25
const INTERSECT_EPS = 1e-8

const KIND_LABELS = {
  wood: '木板',
  shadow: '阴影',
  rough: '粗边',
  bed: '台面',
}

export function kindLabel(kind) {
  return KIND_LABELS[kind] ?? kind
}

export function detectTable(cv, image) {
  const { working, scaleX, scaleY } = downscale(cv, image)
  try {
    const cloth = getCloth(cv, working)
    if (!cloth) return null

    try {
      const lines = getSides(cv, cloth)
      const quad = getQuad(cv, lines, cloth.rows, cloth.cols, cloth.rough)
      return scaleQuad(quad, scaleX, scaleY)
    } finally {
      release(cloth.gray)
    }
  } finally {
    if (working !== image) release(working)
  }
}

function downscale(cv, image) {
  const shortSide = Math.min(image.rows, image.cols)
  if (shortSide <= DETECT_SHORT_SIDE) return { working: image, scaleX: 1, scaleY: 1 }

  const factor = DETECT_SHORT_SIDE / shortSide
  const cols = Math.max(2, Math.round(image.cols * factor))
  const rows = Math.max(2, Math.round(image.rows * factor))
  const working = new cv.Mat()
  try {
    cv.resize(image, working, new cv.Size(cols, rows), 0, 0, cv.INTER_AREA)
  } catch (error) {
    release(working)
    throw error
  }
  return { working, scaleX: image.cols / cols, scaleY: image.rows / rows }
}

function scaleQuad(quad, scaleX, scaleY) {
  if (scaleX === 1 && scaleY === 1) return quad
  return quad.map((side) => ({
    start: [side.start[0] * scaleX, side.start[1] * scaleY],
    end: [side.end[0] * scaleX, side.end[1] * scaleY],
    kind: side.kind,
  }))
}

function getCloth(cv, image) {
  const rows = image.rows
  const cols = image.cols
  if (rows < 2 || cols < 2) return null

  const gray = new cv.Mat()
  const owned = []
  const candidates = []
  let result = null

  try {
    const grayCode = image.channels() === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_RGB2GRAY
    cv.cvtColor(image, gray, grayCode)

    const stride = Math.max(1, rint(Math.min(rows, cols) / SAMPLED_SHORT_SIDE))
    const sampled = sampleHls(cv, image, stride)
    const { hue, lightness, saturation, sampledRows, sampledCols } = sampled
    const sampledCount = hue.length

    const weights = gaussianWeights(sampled, rows, cols, stride)
    const hist = new Float64Array(HUE_BINS * SATURATION_BINS)
    for (let index = 0; index < sampledCount; index++) {
      const weight = weights[index]
      if (weight === 0) continue
      const hueBin = hue[index] < HUE_BINS ? hue[index] : HUE_BINS - 1
      const saturationBin = saturation[index] < SATURATION_BINS ? saturation[index] : SATURATION_BINS - 1
      hist[hueBin * SATURATION_BINS + saturationBin] += weight
    }

    const binary = cv.Mat.zeros(HUE_BINS, SATURATION_BINS, cv.CV_8UC1)
    const kernel = cv.getStructuringElement(
      cv.MORPH_ELLIPSE,
      new cv.Size(2 * SATURATION_RADIUS + 1, 2 * HUE_RADIUS + 1),
    )
    const closed = new cv.Mat()
    owned.push(binary, kernel, closed)

    const binaryData = binary.data
    const binThreshold = sampledCount * BINARY_THRESHOLD
    for (let index = 0; index < hist.length; index++) {
      if (hist[index] >= binThreshold) binaryData[index] = 255
    }
    cv.morphologyEx(
      binary,
      closed,
      cv.MORPH_CLOSE,
      kernel,
      new cv.Point(-1, -1),
      1,
      cv.BORDER_CONSTANT,
      cv.morphologyDefaultBorderValue(),
    )

    const labels = new cv.Mat()
    const stats = new cv.Mat()
    const centroids = new cv.Mat()
    owned.push(labels, stats, centroids)
    const count = cv.connectedComponentsWithStats(closed, labels, stats, centroids, 8, cv.CV_32S)
    const regionMin = sampledCount * REGION_SIZE_THRESHOLD

    for (let label = 1; label < count; label++) {
      const saturationMin = stats.intAt(label, cv.CC_STAT_LEFT)
      const hueMin = stats.intAt(label, cv.CC_STAT_TOP)
      const saturationMax = saturationMin + stats.intAt(label, cv.CC_STAT_WIDTH) - 1
      const hueMax = hueMin + stats.intAt(label, cv.CC_STAT_HEIGHT) - 1
      if (sumHistRect(hist, hueMin, hueMax, saturationMin, saturationMax) < regionMin) continue

      const region = cv.Mat.zeros(sampledRows, sampledCols, cv.CV_8UC1)
      let component = null
      try {
        const regionData = region.data
        for (let index = 0; index < sampledCount; index++) {
          const hueValue = hue[index]
          const saturationValue = saturation[index]
          if (
            hueValue >= hueMin && hueValue <= hueMax
            && saturationValue >= saturationMin && saturationValue <= saturationMax
          ) {
            regionData[index] = 255
          }
        }

        component = largestComponent(cv, region)
        if (!component) continue

        const shape = componentShape(cv, component, stride, rows, cols)
        if (!shape) {
          release(component)
          component = null
          continue
        }
        candidates.push({ ...shape, component })
        component = null
      } finally {
        release(region)
        release(component)
      }
    }

    if (candidates.length === 0) return null

    const table = candidates.reduce((best, shape) => (shape.fillRatio > best.fillRatio ? shape : best))
    const clothHue = []
    const clothSaturation = []
    const mask = table.component.data
    for (let index = 0; index < sampledCount; index++) {
      if (mask[index] === 0) continue
      clothHue.push(hue[index])
      clothSaturation.push(saturation[index])
    }

    result = {
      image,
      gray,
      rows,
      cols,
      hueCenter: medianBytes(clothHue),
      saturationCenter: medianBytes(clothSaturation),
      rough: orderQuadrilateral(table.quadrilateral),
    }
    return result
  } finally {
    for (const candidate of candidates) release(candidate.component)
    for (const mat of owned) release(mat)
    if (!result) release(gray)
  }
}

function getSides(cv, cloth) {
  const { image, gray, rows, cols, hueCenter, saturationCenter, rough } = cloth
  const quadrilateral = orderQuadrilateral(rough)
  const center = meanPoint(quadrilateral)
  const shortSide = Math.min(rows, cols)
  const distances = SIDE_DISTANCE_RATIOS.map((ratio) => Math.max(1, ratio * shortSide))
  const inwardLimit = RAIL_INWARD_RATIO * shortSide
  const outwardLimit = RAIL_OUTWARD_RATIO * shortSide
  const chosenMinOffset = CHOSEN_OFFSET_MIN_RATIO * shortSide

  const edges = new cv.Mat()
  const lines = new cv.Mat()
  let segments = []
  try {
    cv.Canny(gray, edges, CANNY_THRESHOLD_LOW, CANNY_THRESHOLD_HIGH, 3, false)
    const minLength = Math.max(1, Math.trunc(HOUGH_MIN_LENGTH_RATIO * shortSide))
    cv.HoughLinesP(
      edges,
      lines,
      HOUGH_RHO,
      HOUGH_ANGLE_STEP,
      HOUGH_THRESHOLD,
      minLength,
      Math.max(1, Math.trunc(minLength * HOUGH_GAP_RATIO)),
    )
    segments = readSegments(lines)
  } finally {
    release(edges)
    release(lines)
  }

  const prepared = []
  const probe = []
  for (let index = 0; index < 4; index++) {
    const start = quadrilateral[index]
    const end = quadrilateral[(index + 1) % 4]
    const delta = [end[0] - start[0], end[1] - start[1]]
    const direction = unit(delta)
    let outward = [-direction[1], direction[0]]
    const sideMiddle = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]
    if (dot(outward, [sideMiddle[0] - center[0], sideMiddle[1] - center[1]]) < 0) {
      outward = [-outward[0], -outward[1]]
    }
    const sideLength = Math.hypot(delta[0], delta[1])

    const kept = []
    for (const segment of segments) {
      const parallel = Math.abs(segment.dirX * direction[0] + segment.dirY * direction[1])
      if (parallel < RAIL_PARALLEL) continue

      const fromMiddleX = segment.midX - sideMiddle[0]
      const fromMiddleY = segment.midY - sideMiddle[1]
      const signed = fromMiddleX * outward[0] + fromMiddleY * outward[1]
      const along = fromMiddleX * direction[0] + fromMiddleY * direction[1]
      if (signed < -inwardLimit || signed > outwardLimit || Math.abs(along) > sideLength * ALONG_SPAN_RATIO) {
        continue
      }

      kept.push({ segment, offset: signed })
      collectProbes(probe, segment, outward, distances, rows, cols)
    }
    prepared.push({ start, end, outward, kept })
  }

  const read = hlsLookup(cv, image, probe)
  const sides = []
  for (const side of prepared) {
    const marks = []
    for (const item of side.kept) {
      const classified = classifySegment(item.segment, side.outward, distances, read, rows, cols, hueCenter, saturationCenter)
      if (!classified) continue
      marks.push({
        kind: classified.kind,
        support: classified.support,
        offset: item.offset,
        length: item.segment.length,
        segment: item.segment,
      })
    }

    const wood = chooseMark(marks, 'wood', chosenMinOffset)
    const shadow = chooseMark(marks, 'shadow', chosenMinOffset)
    let used = null
    let kind = 'rough'
    if (wood) {
      used = wood
      kind = 'wood'
    } else if (shadow) {
      used = shadow
      kind = 'shadow'
    }

    const line = used
      ? lineThrough([used.segment.x1, used.segment.y1], [used.segment.x2, used.segment.y2])
      : lineThrough(side.start, side.end)
    sides.push({ line, kind })
  }

  return sides
}

function getQuad(cv, sides, rows, cols, quadrilateral) {
  const center = meanPoint(quadrilateral)
  const limit = CORNER_MOVE_RATIO * Math.min(rows, cols)
  const corners = []

  for (let index = 0; index < 4; index++) {
    const point = intersect(sides[(index + 3) % 4].line, sides[index].line)
    const nearRough = point !== null && Math.hypot(point[0] - quadrilateral[index][0], point[1] - quadrilateral[index][1]) <= limit
    const insideImage = point !== null && point[0] >= 0 && point[0] < cols && point[1] >= 0 && point[1] < rows
    corners.push(insideImage && nearRough ? point : quadrilateral[index])
  }

  let finalCorners = corners
  let kinds = sides.map((side) => side.kind)
  if (pointPolygonContainsCenter(cv, corners, center) < 0) {
    finalCorners = quadrilateral
    kinds = ['rough', 'rough', 'rough', 'rough']
  }

  return finalCorners.map((start, index) => ({
    start,
    end: finalCorners[(index + 1) % 4],
    kind: kinds[index],
  }))
}

function sampleHls(cv, image, stride) {
  const rows = image.rows
  const cols = image.cols
  const channels = image.channels()
  if (channels !== 3 && channels !== 4) throw new Error('detectTable 需要 RGB 或 RGBA 图像')
  const sampledRows = Math.floor((rows - 1) / stride) + 1
  const sampledCols = Math.floor((cols - 1) / stride) + 1
  const sampledCount = sampledRows * sampledCols
  const packed = new Uint8Array(sampledCount * 3)
  const source = image.data
  let index = 0

  for (let y = 0; y < rows; y += stride) {
    const row = y * cols
    for (let x = 0; x < cols; x += stride) {
      const offset = (row + x) * channels
      const dest = index * 3
      packed[dest] = source[offset + 2]
      packed[dest + 1] = source[offset + 1]
      packed[dest + 2] = source[offset]
      index += 1
    }
  }

  const bgr = cv.matFromArray(sampledRows, sampledCols, cv.CV_8UC3, packed)
  const hls = new cv.Mat()
  try {
    cv.cvtColor(bgr, hls, cv.COLOR_BGR2HLS)
    const hue = new Uint8Array(sampledCount)
    const lightness = new Uint8Array(sampledCount)
    const saturation = new Uint8Array(sampledCount)
    const data = hls.data
    for (let pixel = 0; pixel < sampledCount; pixel++) {
      const offset = pixel * 3
      hue[pixel] = data[offset]
      lightness[pixel] = data[offset + 1]
      saturation[pixel] = data[offset + 2]
    }
    return { hue, lightness, saturation, sampledRows, sampledCols }
  } finally {
    release(hls)
    release(bgr)
  }
}

function collectProbes(points, segment, outward, distances, rows, cols) {
  for (let step = 0; step < SAMPLE_COUNT; step++) {
    const along = SAMPLE_T_START + (SAMPLE_T_END - SAMPLE_T_START) * step / (SAMPLE_COUNT - 1)
    const originX = segment.x1 * (1 - along) + segment.x2 * along
    const originY = segment.y1 * (1 - along) + segment.y2 * along
    for (let sign = -1; sign <= 1; sign += 2) {
      for (const distance of distances) {
        const x = rint(originX + outward[0] * sign * distance)
        const y = rint(originY + outward[1] * sign * distance)
        if (x < 0 || x >= cols || y < 0 || y >= rows) continue
        points.push(x, y)
      }
    }
  }
}

function hlsLookup(cv, image, points) {
  const cols = image.cols
  const channels = image.channels()
  const source = image.data
  const indexOf = new Map()
  const unique = []
  for (let i = 0; i < points.length; i += 2) {
    const key = points[i + 1] * cols + points[i]
    if (indexOf.has(key)) continue
    indexOf.set(key, unique.length)
    unique.push(key)
  }

  const values = new Uint8Array(Math.max(1, unique.length) * 3)
  if (unique.length > 0) {
    const packed = new Uint8Array(unique.length * 3)
    for (let i = 0; i < unique.length; i++) {
      const offset = unique[i] * channels
      const dest = i * 3
      packed[dest] = source[offset + 2]
      packed[dest + 1] = source[offset + 1]
      packed[dest + 2] = source[offset]
    }
    const bgr = cv.matFromArray(1, unique.length, cv.CV_8UC3, packed)
    const hls = new cv.Mat()
    try {
      cv.cvtColor(bgr, hls, cv.COLOR_BGR2HLS)
      values.set(hls.data.subarray(0, unique.length * 3))
    } finally {
      release(hls)
      release(bgr)
    }
  }

  return (x, y) => {
    const at = indexOf.get(y * cols + x)
    const offset = at * 3
    return [values[offset], values[offset + 1], values[offset + 2]]
  }
}

function gaussianWeights(sampled, imageRows, imageCols, stride) {
  const { lightness, sampledRows, sampledCols } = sampled
  const centerRow = (imageRows / 2) / stride
  const centerCol = (imageCols / 2) / stride
  const sigmaRow = imageRows * GAUSSIAN_SIGMA_X / stride
  const sigmaCol = imageCols * GAUSSIAN_SIGMA_Y / stride
  const invRow = 1 / (2 * sigmaRow * sigmaRow)
  const invCol = 1 / (2 * sigmaCol * sigmaCol)
  const weights = new Float64Array(lightness.length)
  let index = 0

  for (let row = 0; row < sampledRows; row++) {
    const rowTerm = (row - centerRow) ** 2 * invRow
    for (let col = 0; col < sampledCols; col++, index++) {
      const level = lightness[index]
      if (level <= SHADOW_THRESHOLD || level >= HIGHLIGHT_THRESHOLD) continue
      weights[index] = Math.exp(-(rowTerm + (col - centerCol) ** 2 * invCol))
    }
  }

  return weights
}

function sumHistRect(hist, hueMin, hueMax, saturationMin, saturationMax) {
  let sum = 0
  for (let hue = hueMin; hue <= hueMax; hue++) {
    const row = hue * SATURATION_BINS
    for (let saturation = saturationMin; saturation <= saturationMax; saturation++) {
      sum += hist[row + saturation]
    }
  }
  return sum
}

function largestComponent(cv, region) {
  const labels = new cv.Mat()
  const stats = new cv.Mat()
  const centroids = new cv.Mat()
  try {
    const count = cv.connectedComponentsWithStats(region, labels, stats, centroids, 8, cv.CV_32S)
    if (count < 2) return null

    let best = 1
    let bestArea = stats.intAt(1, cv.CC_STAT_AREA)
    for (let label = 2; label < count; label++) {
      const area = stats.intAt(label, cv.CC_STAT_AREA)
      if (area > bestArea) {
        bestArea = area
        best = label
      }
    }

    const out = cv.Mat.zeros(region.rows, region.cols, cv.CV_8UC1)
    const source = labels.data32S
    const destination = out.data
    const total = region.rows * region.cols
    for (let index = 0; index < total; index++) {
      if (source[index] === best) destination[index] = 255
    }
    return out
  } finally {
    release(labels)
    release(stats)
    release(centroids)
  }
}

function componentShape(cv, component, stride, imageRows, imageCols) {
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  let contour = null
  let hull = null
  let approx = null
  let hullMask = null
  let hulls = null

  try {
    cv.findContours(component, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    const count = contours.size()
    if (count === 0) return null

    let bestIndex = 0
    let bestArea = -1
    for (let index = 0; index < count; index++) {
      const current = contours.get(index)
      const area = cv.contourArea(current, false)
      release(current)
      if (area > bestArea) {
        bestArea = area
        bestIndex = index
      }
    }

    const selected = contours.get(bestIndex)
    contour = selected.clone()
    release(selected)

    hull = new cv.Mat()
    cv.convexHull(contour, hull, false, true)
    approx = new cv.Mat()
    cv.approxPolyDP(hull, approx, POLY_EPSILON_RATIO * cv.arcLength(hull, true), true)
    const points = readPoints(approx)
    if (points.length !== 4) return null

    hullMask = cv.Mat.zeros(component.rows, component.cols, cv.CV_8UC1)
    hulls = new cv.MatVector()
    hulls.push_back(hull)
    cv.drawContours(hullMask, hulls, -1, new cv.Scalar(255), -1, cv.LINE_8)

    const hullArea = cv.countNonZero(hullMask)
    const area = cv.countNonZero(component)
    if (hullArea === 0) return null
    const fillRatio = area / hullArea
    if (fillRatio < FILL_RATIO_MIN) return null

    const moments = cv.moments(contour, false)
    if (moments.m00 === 0) return null
    const center = [moments.m10 / moments.m00 * stride, moments.m01 / moments.m00 * stride]
    if (!centerIsOnTable(center, imageRows, imageCols)) return null

    return {
      quadrilateral: points.map(([x, y]) => [x * stride, y * stride]),
      fillRatio,
    }
  } finally {
    release(hulls)
    release(hullMask)
    release(approx)
    release(hull)
    release(contour)
    release(hierarchy)
    release(contours)
  }
}

function centerIsOnTable(center, imageRows, imageCols) {
  const [x, y] = center
  return CENTER_X_MIN * imageCols <= x && x <= CENTER_X_MAX * imageCols
    && CENTER_Y_MIN * imageRows <= y && y <= CENTER_Y_MAX * imageRows
}

function readSegments(lines) {
  if (lines.rows === 0 || lines.cols === 0) return []
  const data = lines.data32S
  // OpenCV.js 5 stores HoughLinesP as 1×N×4. Older builds use N×1×4. Both are groups of four ints.
  const lineCount = Math.floor(lines.rows * lines.cols * lines.channels() / 4)
  const segments = []

  for (let index = 0; index < lineCount; index++) {
    const offset = index * 4
    const x1 = data[offset]
    const y1 = data[offset + 1]
    const x2 = data[offset + 2]
    const y2 = data[offset + 3]
    const dx = x2 - x1
    const dy = y2 - y1
    const length = Math.hypot(dx, dy)
    if (length === 0) continue
    segments.push({
      x1, y1, x2, y2, length,
      dirX: dx / length,
      dirY: dy / length,
      midX: (x1 + x2) / 2,
      midY: (y1 + y2) / 2,
    })
  }

  return segments
}

function classifySegment(segment, outward, distances, read, rows, cols, hueCenter, saturationCenter) {
  const votes = []

  for (let step = 0; step < SAMPLE_COUNT; step++) {
    const along = SAMPLE_T_START + (SAMPLE_T_END - SAMPLE_T_START) * step / (SAMPLE_COUNT - 1)
    const originX = segment.x1 * (1 - along) + segment.x2 * along
    const originY = segment.y1 * (1 - along) + segment.y2 * along
    const inward = sideReading(originX, originY, -1)
    const outwardReading = sideReading(originX, originY, 1)
    if (!inward || !outwardReading) continue

    const inwardShadow = inward.sameHue >= LABEL_FRACTION
      && inward.level + SHADOW_LIGHTNESS_GAP < outwardReading.level
      && inward.level <= SHADOW_LIGHTNESS_RATIO * outwardReading.level
    const outwardShadow = outwardReading.sameHue >= LABEL_FRACTION
      && outwardReading.level + SHADOW_LIGHTNESS_GAP < inward.level
      && outwardReading.level <= SHADOW_LIGHTNESS_RATIO * inward.level
    const inwardName = inwardShadow ? 'shadow' : (inward.cloth >= LABEL_FRACTION ? 'cloth' : 'other')
    const outwardName = outwardShadow ? 'shadow' : (outwardReading.cloth >= LABEL_FRACTION ? 'cloth' : 'other')

    if (inwardName === 'cloth' && outwardName === 'shadow') votes.push('bed')
    else if (inwardName === 'shadow' && outwardName === 'cloth') votes.push('shadow')
    else if ((inwardName === 'cloth' || inwardName === 'shadow') && outwardName === 'other') votes.push('wood')
  }

  if (votes.length < MIN_VOTES) return null
  const winner = winningVote(votes)
  if (winner.support < MIN_SUPPORT) return null
  return winner

  function sideReading(originX, originY, sign) {
    const levels = []
    let cloth = 0
    let sameHue = 0

    for (const distance of distances) {
      const x = rint(originX + outward[0] * sign * distance)
      const y = rint(originY + outward[1] * sign * distance)
      if (x < 0 || x >= cols || y < 0 || y >= rows) continue

      const [hueValue, lightnessValue, saturationValue] = read(x, y)
      levels.push(lightnessValue)
      if (matchesCloth(hueValue, saturationValue, lightnessValue)) cloth += 1
      if (hueDistance(hueValue, hueCenter) <= CLOTH_HUE_TOLERANCE) sameHue += 1
    }

    if (levels.length < MIN_SIDE_POINTS) return null
    return {
      level: median(levels),
      cloth: cloth / levels.length,
      sameHue: sameHue / levels.length,
    }
  }

  function matchesCloth(hueValue, saturationValue, lightnessValue) {
    return hueDistance(hueValue, hueCenter) <= CLOTH_HUE_TOLERANCE
      && Math.abs(saturationValue - saturationCenter) <= CLOTH_SATURATION_TOLERANCE
      && lightnessValue < CLOTH_LIGHTNESS_MAX
  }
}

function chooseMark(marks, kind, chosenMinOffset) {
  const group = marks.filter((mark) => mark.kind === kind && mark.offset >= chosenMinOffset)
  if (group.length === 0) return null
  if (kind === 'wood') {
    return group.reduce((best, mark) => {
      if (mark.length > best.length || (mark.length === best.length && mark.support > best.support)) return mark
      return best
    })
  }
  return group.reduce((best, mark) => {
    if (mark.offset < best.offset || (mark.offset === best.offset && mark.length > best.length)) return mark
    return best
  })
}

function pointPolygonContainsCenter(cv, corners, center) {
  const data = []
  for (const [x, y] of corners) {
    data.push(x, y)
  }
  const contour = cv.matFromArray(corners.length, 1, cv.CV_32FC2, data)
  try {
    return cv.pointPolygonTest(contour, new cv.Point(center[0], center[1]), false)
  } finally {
    release(contour)
  }
}

function readPoints(mat) {
  if (mat.channels() !== 2) {
    throw new Error(`无法读取轮廓点：type=${mat.type()} size=${mat.rows}x${mat.cols}`)
  }
  const useFloat = mat.depth() === cv.CV_32F
  const points = []
  for (let row = 0; row < mat.rows; row++) {
    for (let col = 0; col < mat.cols; col++) {
      const ptr = useFloat ? mat.floatPtr(row, col) : mat.intPtr(row, col)
      points.push([ptr[0], ptr[1]])
    }
  }
  return points
}

function hueDistance(hueValue, hueCenter) {
  const delta = Math.abs(hueValue - hueCenter)
  return Math.min(delta, HUE_BINS - delta)
}

function orderQuadrilateral(points) {
  const center = meanPoint(points)
  return points
    .map((point, index) => ({
      point,
      index,
      angle: Math.atan2(point[1] - center[1], point[0] - center[0]),
    }))
    .sort((a, b) => a.angle - b.angle || a.index - b.index)
    .map((item) => item.point)
}

function meanPoint(points) {
  let x = 0
  let y = 0
  for (const point of points) {
    x += point[0]
    y += point[1]
  }
  return [x / points.length, y / points.length]
}

function lineThrough(start, end) {
  return [
    start[1] - end[1],
    end[0] - start[0],
    start[0] * end[1] - end[0] * start[1],
  ]
}

function intersect(lineA, lineB) {
  const point = [
    lineA[1] * lineB[2] - lineA[2] * lineB[1],
    lineA[2] * lineB[0] - lineA[0] * lineB[2],
    lineA[0] * lineB[1] - lineA[1] * lineB[0],
  ]
  if (Math.abs(point[2]) < INTERSECT_EPS) return null
  return [point[0] / point[2], point[1] / point[2]]
}

function winningVote(votes) {
  const counts = new Map()
  for (const vote of votes) counts.set(vote, (counts.get(vote) ?? 0) + 1)

  let kind = votes[0]
  let best = 0
  for (const [name, count] of counts) {
    if (count > best) {
      best = count
      kind = name
    }
  }
  return { kind, support: best / votes.length }
}

function median(values) {
  const ordered = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(ordered.length / 2)
  if (ordered.length % 2) return ordered[mid]
  return (ordered[mid - 1] + ordered[mid]) / 2
}

function medianBytes(values) {
  const bins = new Uint32Array(256)
  for (let index = 0; index < values.length; index++) bins[values[index]] += 1
  const count = values.length
  const lowIndex = count % 2 ? count >> 1 : (count >> 1) - 1
  const highIndex = count >> 1
  let seen = 0
  let low = 0
  let high = 0
  let haveLow = false
  for (let value = 0; value < 256; value++) {
    const next = seen + bins[value]
    if (!haveLow && next > lowIndex) {
      low = value
      haveLow = true
    }
    if (next > highIndex) {
      high = value
      break
    }
    seen = next
  }
  return count % 2 ? low : (low + high) / 2
}

function unit(vector) {
  const length = Math.hypot(vector[0], vector[1])
  return [vector[0] / length, vector[1] / length]
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1]
}

function rint(value) {
  const negative = value < 0
  const abs = negative ? -value : value
  const floor = Math.floor(abs)
  const fraction = abs - floor
  let rounded = floor
  if (fraction > 0.5) rounded = floor + 1
  else if (fraction === 0.5 && floor % 2 !== 0) rounded = floor + 1
  return negative ? -rounded : rounded
}

function release(mat) {
  if (mat && !mat.isDeleted?.()) mat.delete()
}
