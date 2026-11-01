// 由台面四个角点和真实尺寸估计相机。台面在 z = 0，原点在台心，长边沿 X，短边沿 Y。

export const TABLE_BEDS = [
  { id: 'chinese', label: '中式', length: 2540, width: 1270 },
  { id: 'snooker', label: '斯诺克', length: 3570, width: 1780 },
]

// 转播长焦可以到图像宽度的三倍以上，所以搜索范围比普通手机广角更宽。
const FOCAL_MIN_RATIO = 0.4
const FOCAL_MAX_RATIO = 8
const COARSE_FOCAL_STEPS = 32
const FINE_FOCAL_STEPS = 9

export function solveTablePose(cv, sides, imageWidth, imageHeight, bed) {
  const imageCorners = sides.map((side) => side.start)
  if (imageCorners.length !== 4 || imageWidth < 2 || imageHeight < 2) return null

  const object = objectCorners(bed.length, bed.width)
  const correspondences = cornerCorrespondences(imageCorners)
  const coarse = sampleRange(imageWidth * FOCAL_MIN_RATIO, imageWidth * FOCAL_MAX_RATIO, COARSE_FOCAL_STEPS)
  let best = searchFocals(cv, object, correspondences, coarse, imageWidth, imageHeight)
  if (!best) return null

  const step = (imageWidth * (FOCAL_MAX_RATIO - FOCAL_MIN_RATIO)) / (COARSE_FOCAL_STEPS - 1)
  const fineMin = Math.max(imageWidth * FOCAL_MIN_RATIO, best.focalLength - step)
  const fineMax = Math.min(imageWidth * FOCAL_MAX_RATIO, best.focalLength + step)
  const fine = sampleRange(fineMin, fineMax, FINE_FOCAL_STEPS)
  return searchFocals(cv, object, correspondences, fine, imageWidth, imageHeight) ?? best
}

function searchFocals(cv, object, correspondences, focals, imageWidth, imageHeight) {
  const flags = typeof cv.SOLVEPNP_IPPE === 'number' ? cv.SOLVEPNP_IPPE : 6
  let best = null

  for (const image of correspondences) {
    const obj = cv.matFromArray(4, 1, cv.CV_64FC3, object.flat())
    const img = cv.matFromArray(4, 1, cv.CV_64FC2, image.flat())
    const camera = cv.matFromArray(3, 3, cv.CV_64FC1, [
      focals[0], 0, imageWidth / 2,
      0, focals[0], imageHeight / 2,
      0, 0, 1,
    ])
    const dist = cv.Mat.zeros(4, 1, cv.CV_64FC1)
    const rvec = new cv.Mat()
    const tvec = new cv.Mat()

    try {
      const cameraData = camera.data64F
      for (const focalLength of focals) {
        cameraData[0] = focalLength
        cameraData[4] = focalLength
        const poses = solveCandidates(cv, obj, img, camera, dist, rvec, tvec, flags)
        for (const pose of poses) {
          best = prefer(best, scorePose(pose.rotation, pose.translation, object, image, focalLength, imageWidth, imageHeight))
          best = prefer(best, scorePose(
            oppositeRotation(pose.rotation),
            [-pose.translation[0], -pose.translation[1], -pose.translation[2]],
            object,
            image,
            focalLength,
            imageWidth,
            imageHeight,
          ))
        }
      }
    } finally {
      release(obj)
      release(img)
      release(camera)
      release(dist)
      release(rvec)
      release(tvec)
    }
  }

  return best
}

function solveCandidates(cv, objectPoints, imagePoints, camera, dist, rvec, tvec, flags) {
  const poses = []
  if (typeof cv.solvePnPGeneric === 'function') {
    const rvecs = new cv.MatVector()
    const tvecs = new cv.MatVector()
    try {
      cv.solvePnPGeneric(objectPoints, imagePoints, camera, dist, rvecs, tvecs, false, flags)
      for (let index = 0; index < rvecs.size(); index++) {
        const rotationVec = rvecs.get(index)
        const translationVec = tvecs.get(index)
        const rotation = rodrigues(readVector(cv, rotationVec))
        const translation = readVector(cv, translationVec)
        release(rotationVec)
        release(translationVec)
        if (rotation && translation) poses.push({ rotation, translation })
      }
      if (poses.length > 0) return poses
    } catch {
      // 这个构建如果没有 Generic 的向量参数，就退回单解。
    } finally {
      release(rvecs)
      release(tvecs)
    }
  }

  rvec.create(3, 1, cv.CV_64FC1)
  tvec.create(3, 1, cv.CV_64FC1)
  const ok = cv.solvePnP(objectPoints, imagePoints, camera, dist, rvec, tvec, false, flags)
  if (ok === false) return []
  const rotation = rodrigues(readVector(cv, rvec))
  const translation = readVector(cv, tvec)
  if (!rotation || !translation) return []
  return [{ rotation, translation }]
}

function scorePose(rotation, translation, object, image, focalLength, imageWidth, imageHeight) {
  if (!rotation || !translation) return null
  let error = 0
  for (let index = 0; index < object.length; index++) {
    const point = project(rotation, translation, focalLength, imageWidth / 2, imageHeight / 2, object[index])
    if (point[2] <= 1) return null
    error += Math.hypot(point[0] - image[index][0], point[1] - image[index][1])
  }
  error /= object.length

  const position = cameraPosition(rotation, translation)
  let rank = 2
  if (position[2] > 0) rank = rotation[8] < 0 ? 0 : 1
  return {
    focalLength,
    rotation,
    translation,
    position,
    error,
    rank,
    width: imageWidth,
    height: imageHeight,
  }
}

function prefer(current, candidate) {
  if (!candidate || !Number.isFinite(candidate.error)) return current
  if (!current) return candidate
  if (candidate.rank < current.rank) return candidate
  if (candidate.rank === current.rank && candidate.error < current.error) return candidate
  return current
}

function objectCorners(length, width) {
  const x = length / 2
  const y = width / 2
  return [
    [-x, -y, 0],
    [x, -y, 0],
    [x, y, 0],
    [-x, y, 0],
  ]
}

function cornerCorrespondences(imageCorners) {
  const correspondences = []
  for (const reverse of [false, true]) {
    const ring = reverse ? [...imageCorners].reverse() : imageCorners
    for (let shift = 0; shift < 4; shift++) {
      const image = []
      for (let index = 0; index < 4; index++) image.push(ring[(index + shift) % 4])
      correspondences.push(image)
    }
  }
  return correspondences
}

function oppositeRotation(rotation) {
  return [
    -rotation[0], -rotation[1], rotation[2],
    -rotation[3], -rotation[4], rotation[5],
    -rotation[6], -rotation[7], rotation[8],
  ]
}

function project(rotation, translation, focalLength, centerX, centerY, point) {
  const x = rotation[0] * point[0] + rotation[1] * point[1] + rotation[2] * point[2] + translation[0]
  const y = rotation[3] * point[0] + rotation[4] * point[1] + rotation[5] * point[2] + translation[1]
  const z = rotation[6] * point[0] + rotation[7] * point[1] + rotation[8] * point[2] + translation[2]
  return [focalLength * x / z + centerX, focalLength * y / z + centerY, z]
}

function cameraPosition(rotation, translation) {
  return [
    -(rotation[0] * translation[0] + rotation[3] * translation[1] + rotation[6] * translation[2]),
    -(rotation[1] * translation[0] + rotation[4] * translation[1] + rotation[7] * translation[2]),
    -(rotation[2] * translation[0] + rotation[5] * translation[1] + rotation[8] * translation[2]),
  ]
}

function rodrigues(rvec) {
  if (!rvec || rvec.length < 3) return null
  const theta = Math.hypot(rvec[0], rvec[1], rvec[2])
  if (theta < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1]
  const x = rvec[0] / theta
  const y = rvec[1] / theta
  const z = rvec[2] / theta
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const axis = 1 - c
  return [
    c + x * x * axis, x * y * axis - z * s, x * z * axis + y * s,
    y * x * axis + z * s, c + y * y * axis, y * z * axis - x * s,
    z * x * axis - y * s, z * y * axis + x * s, c + z * z * axis,
  ]
}

function readVector(cv, mat) {
  if (!mat || mat.empty?.()) return null
  const count = mat.rows * mat.cols * mat.channels()
  if (count < 3) return null
  const depth = mat.depth()
  const data = depth === cv.CV_64F ? mat.data64F : mat.data32F
  return [data[0], data[1], data[2]]
}

function sampleRange(min, max, count) {
  if (count <= 1 || min === max) return [min]
  const step = (max - min) / (count - 1)
  return Array.from({ length: count }, (_, index) => min + step * index)
}

function release(mat) {
  if (mat && !mat.isDeleted?.()) mat.delete()
}
