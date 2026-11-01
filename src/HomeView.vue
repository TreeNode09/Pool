<template>
  <main class="home">
    <h1>Pool</h1>
    <p>用后置摄像头对准台面</p>
    <button type="button" :disabled="opening" @click="start">开始检测</button>
    <p v-if="errorText" class="error">{{ errorText }}</p>
  </main>
</template>

<script setup>
import { ref } from 'vue'
import { cameraErrorText, openCamera } from './camera.js'

const emit = defineEmits(['start'])

const opening = ref(false)
const errorText = ref('')

async function start() {
  if (opening.value) return
  opening.value = true
  errorText.value = ''
  try {
    const stream = await openCamera()
    emit('start', stream)
  } catch (error) {
    errorText.value = cameraErrorText(error)
  } finally {
    opening.value = false
  }
}
</script>

<style scoped>
.home {
  box-sizing: border-box;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 1.5rem;
  background: var(--black);
  color: var(--white);
  font-family: system-ui, sans-serif;
  text-align: center;
}

h1 {
  margin: 0;
  font-size: 2rem;
  font-weight: 650;
  letter-spacing: 0.04em;
}

p {
  margin: 0;
  font-size: 0.95rem;
  line-height: 1.5;
}

button {
  margin-top: 0.75rem;
  min-width: 8.5rem;
  min-height: 44px;
  padding: 0.7rem 1.4rem;
  border: 0;
  border-radius: 999px;
  background: var(--main);
  color: var(--black);
  font: inherit;
  font-weight: 650;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

button:disabled {
  cursor: default;
  opacity: 0.6;
}

.error {
  max-width: 18rem;
  font-weight: 600;
}
</style>
