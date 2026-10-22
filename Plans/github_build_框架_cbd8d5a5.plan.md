---
name: GitHub Build 框架
overview: 第一步用 Vue 3 + Vite 做拍照页，并加载 OpenCV.js，把照片读成 Mat 再画回画面，确认手机浏览器里框架和 OpenCV 都跑通。先不识别球，也不部署。
todos:
  - id: vue-opencv-capture
    content: 用 Vue 3 + Vite 做拍照页，加载 OpenCV.js，把照片读成 Mat 并画回 canvas
    status: pending
isProject: false
---

# 第一步：Vue + OpenCV.js 跑通拍照

GitHub Pages 的 Build and deployment 可以托管 Vue。Vue 需要先 `npm run build`，所以正式发布时 Source 用 **GitHub Actions**，把 `dist/` 部署出去。手机打开的仍是静态页面。这一步先在本机跑通，先不配 Actions。

## 这一步做什么

在空目录 [d:\Pool](d:\Pool) 搭一个 **Vue 3 + Vite** 项目（JavaScript，不用 TypeScript）。页面只做三件事：

1. 打开页面时加载 OpenCV.js，状态从「加载中」变成「就绪」。OpenCV.js 是单文件 WASM 构建，体积大约数 MB，要等 `cv.onRuntimeInitialized` 之后才能调用。
2. 用 `<input type="file" accept="image/*" capture="environment">` 拍照或从相册选图。这个方式在手机浏览器里不要求 HTTPS，同一 Wi-Fi 下用 `npm run dev -- --host` 就能在手机上试。
3. 把图画到 canvas，再用 `cv.imread` 读成 `cv.Mat`，把宽、高、通道数显示出来，然后 `cv.imshow` 画回去。用完执行 `mat.delete()`，避免 WASM 内存只增不减。

先不找球桌、不分类颜色、不加 Three.js。能在手机上看到「OpenCV 就绪」和 Mat 的尺寸，就算这条链路通了。

## 文件怎么放

- [index.html](index.html)：在 Vue 入口之前用 `<script async>` 引入 OpenCV.js。
- [src/main.js](src/main.js)、[src/App.vue](src/App.vue)：页面和状态。Vue 只保管「是否就绪、当前图片、Mat 尺寸」这几项。
- [src/opencv.js](src/opencv.js)：一个 `waitForOpencv()`，把 `onRuntimeInitialized` 包成 Promise，页面只关心就绪或失败。

脚本先用官方文档上的单文件地址（例如 `https://docs.opencv.org/4.10.0/opencv.js`），这样仓库里不必放一个约 10 MB 的文件。以后部署到 GitHub Pages 时再拷进 `public/`，避免手机依赖 docs.opencv.org。

## 先不做的

- 球和球桌检测、透视校正、Three.js。
- GitHub Actions 部署。本机和手机确认之后再加。
- 实时摄像头（`getUserMedia`）。它要求 HTTPS 或 localhost，留给 Pages 部署之后。
