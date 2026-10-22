import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'

const OPENCV_URL = 'https://docs.opencv.org/5.0/opencv.js'
const OPENCV_MD5 = '703926ba3f5967a21cbc3b5ab18c87a1'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dest = path.join(root, 'public', 'opencv.js')

let pending = null

export function ensureOpencv() {
  if (!pending) {
    pending = downloadIfNeeded().catch((error) => {
      pending = null
      throw error
    })
  }
  return pending
}

async function downloadIfNeeded() {
  if ((await fileMd5(dest)) === OPENCV_MD5) return dest

  await mkdir(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.download`
  console.log('正在下载 OpenCV.js…')
  const response = await fetch(OPENCV_URL)
  if (!response.ok) {
    throw new Error(`OpenCV.js 下载失败：${response.status}`)
  }

  let received = 0
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      if (received === chunk.length || received % (4 * 1024 * 1024) < chunk.length) {
        console.log(`已下载 ${(received / 1024 / 1024).toFixed(1)} MB`)
      }
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(tmp))

  if ((await fileMd5(tmp)) !== OPENCV_MD5) {
    await rm(tmp, { force: true })
    throw new Error('下载的 OpenCV.js 校验失败')
  }

  await rm(dest, { force: true })
  await rename(tmp, dest)
  console.log('OpenCV.js 已保存到 public/opencv.js')
  return dest
}

function fileMd5(file) {
  return new Promise((resolve) => {
    const hash = createHash('md5')
    const stream = createReadStream(file)
    stream.on('error', () => resolve(null))
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

const isDirect = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (isDirect) {
  ensureOpencv().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
