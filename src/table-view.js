import * as THREE from 'three'

// OpenCV 相机 X 朝右、Y 朝下、Z 朝前。Three.js 相机 X 朝右、Y 朝上、看着 -Z。
export function createTableView(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  renderer.setPixelRatio(1)
  renderer.setClearColor(0x000000, 0)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(40, 1, 10, 1e6)
  camera.matrixAutoUpdate = false

  let mesh = null

  return {
    show(pose, bed) {
      renderer.setSize(pose.width, pose.height, false)
      ensurePlane(bed.length, bed.width)
      applyPose(camera, pose)
      renderer.render(scene, camera)
    },
    clear() {
      renderer.clear()
    },
  }

  function ensurePlane(length, width) {
    if (mesh?.userData.length === length && mesh.userData.width === width) return
    if (mesh) {
      scene.remove(mesh)
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
    mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(length, width),
      new THREE.MeshBasicMaterial({
        color: 0x14914a,
        transparent: true,
        opacity: 0.42,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    mesh.userData.length = length
    mesh.userData.width = width
    scene.add(mesh)
  }
}

function applyPose(camera, pose) {
  const rotation = pose.rotation
  const position = pose.position
  camera.matrix.set(
    rotation[0], -rotation[3], -rotation[6], position[0],
    rotation[1], -rotation[4], -rotation[7], position[1],
    rotation[2], -rotation[5], -rotation[8], position[2],
    0, 0, 0, 1,
  )
  camera.fov = 2 * Math.atan(pose.height / (2 * pose.focalLength)) * 180 / Math.PI
  camera.aspect = pose.width / pose.height
  camera.updateProjectionMatrix()
  camera.matrixWorldNeedsUpdate = true
  camera.updateMatrixWorld(true)
}

