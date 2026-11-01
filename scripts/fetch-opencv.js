import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'

const OPENCV_URL = 'https://docs.opencv.org/5.0/opencv.js'
const OPENCV_MD5 = '703926ba3f5967a21cbc3b5ab18c87a1'
const WASM_FILE = 'opencv_js.wasm'
const DATA_PREFIX = 'data:application/octet-stream;base64,'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const official = path.join(root, 'vendor', 'opencv.js')
const stampPath = path.join(root, 'vendor', 'opencv.stamp')
const scriptOut = path.join(root, 'public', 'opencv.js')
const wasmOut = path.join(root, 'public', WASM_FILE)

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
  if ((await fileMd5(official)) !== OPENCV_MD5) {
    await mkdir(path.dirname(official), { recursive: true })
    if ((await fileMd5(scriptOut)) === OPENCV_MD5) {
      await copyFile(scriptOut, official)
    } else {
      await downloadOfficial()
    }
  }
  if (await splitIsCurrent()) return scriptOut
  await splitOfficial()
  return scriptOut
}

async function downloadOfficial() {
  const tmp = `${official}.download`
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

  await rm(official, { force: true })
  await rename(tmp, official)
  console.log('OpenCV.js 已保存到 vendor/opencv.js')
}

async function splitIsCurrent() {
  try {
    const stamp = (await readFile(stampPath, 'utf8')).trim()
    if (stamp !== OPENCV_MD5) return false
    const handle = await open(wasmOut, 'r')
    try {
      const header = Buffer.alloc(4)
      const { bytesRead } = await handle.read(header, 0, 4, 0)
      if (bytesRead !== 4 || header[0] !== 0x00 || header.toString('ascii', 1, 4) !== 'asm') return false
    } finally {
      await handle.close()
    }
    const script = await readFile(scriptOut, 'utf8')
    return script.includes(`var wasmBinaryFile="${WASM_FILE}"`)
      && !script.includes(`var wasmBinaryFile="${DATA_PREFIX}`)
  } catch {
    return false
  }
}

async function splitOfficial() {
  const source = await readFile(official, 'utf8')
  const marker = `var wasmBinaryFile="${DATA_PREFIX}`
  const start = source.indexOf(marker)
  if (start < 0) throw new Error('官方 OpenCV.js 里没有内嵌的 WASM')
  const b64Start = start + marker.length
  const b64End = source.indexOf('"', b64Start)
  if (b64End < 0) throw new Error('官方 OpenCV.js 里的 WASM 不完整')

  const wasm = Buffer.from(source.slice(b64Start, b64End), 'base64')
  if (wasm[0] !== 0x00 || wasm.toString('ascii', 1, 4) !== 'asm') {
    throw new Error('拆出的 WASM 无效')
  }
  const script = `${source.slice(0, start)}var wasmBinaryFile="${WASM_FILE}"${source.slice(b64End + 1)}`
  if (script.includes(`var wasmBinaryFile="${DATA_PREFIX}`)) {
    throw new Error('拆分后的 OpenCV.js 仍包含内嵌 WASM')
  }

  await mkdir(path.dirname(scriptOut), { recursive: true })
  const scriptTmp = `${scriptOut}.download`
  const wasmTmp = `${wasmOut}.download`
  await writeFile(scriptTmp, script)
  await writeFile(wasmTmp, wasm)
  await rm(scriptOut, { force: true })
  await rm(wasmOut, { force: true })
  await rename(scriptTmp, scriptOut)
  await rename(wasmTmp, wasmOut)
  await writeFile(stampPath, OPENCV_MD5)
  console.log(`OpenCV.js 已拆成 public/opencv.js 和 public/${WASM_FILE}`)
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
