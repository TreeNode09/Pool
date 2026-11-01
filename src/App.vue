<template>
  <HomeView v-if="page === 'home'" @start="openCapture" />
  <CaptureView v-else :stream="captureStream" @back="closeCapture" />
  <div class="landscape">请竖屏使用</div>
</template>

<script setup>
import { ref, shallowRef } from 'vue'
import HomeView from './HomeView.vue'
import CaptureView from './CaptureView.vue'

const page = ref('home')
const captureStream = shallowRef(null)

function openCapture(stream) {
  captureStream.value = stream
  page.value = 'capture'
}

function closeCapture() {
  page.value = 'home'
  captureStream.value = null
}
</script>

<style>
:root {
  --main: #54C527;
  --white: #fff;
  --white-disabled: #fff6;
  --black: #000;
}
</style>

<style>
html,
body,
#app {
  margin: 0;
  height: 100%;
  background: #000;
}

html {
  color-scheme: dark;
}

body {
  overflow: hidden;
}

.landscape {
  display: none;
}

@media (orientation: landscape) {
  .landscape {
    position: fixed;
    inset: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--black);
    color: var(--white);
    font-family: system-ui, sans-serif;
    font-size: 1.05rem;
    font-weight: 650;
    line-height: 1.4;
  }
}
</style>
