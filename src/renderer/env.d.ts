import type { CanvasAPI } from '../preload/index'

declare global {
  interface Window {
    canvas: CanvasAPI
  }
}
