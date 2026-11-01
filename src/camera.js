export const CAMERA_CONSTRAINTS = {
  audio: false,
  video: {
    facingMode: { exact: 'environment' },
    width: { exact: 540 },
    height: { exact: 720 },
  },
}

export function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    const error = new Error('无法使用摄像头')
    error.name = 'NotSupportedError'
    return Promise.reject(error)
  }
  return navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS)
}

export function cameraErrorText(error) {
  const name = error?.name
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return '需要摄像头权限'
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    if (error.constraint === 'facingMode') return '没有可用的后置摄像头'
    return '摄像头不支持 540×720'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有可用的后置摄像头'
  return '无法使用摄像头'
}
