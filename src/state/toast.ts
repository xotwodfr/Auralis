import { create } from 'zustand'

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'error'
}

interface ToastState {
  toasts: Toast[]
  dismiss: (id: number) => void
}

let nextId = 1
export const useToasts = create<ToastState>()((set) => ({
  toasts: [],
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

function push(message: string, kind: Toast['kind']) {
  const id = nextId++
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-2), { id, message, kind }] }))
  // Errors stay longer; users can always dismiss.
  setTimeout(() => useToasts.getState().dismiss(id), kind === 'error' ? 8000 : 4000)
}

export const toast = { info: (m: string) => push(m, 'info'), error: (m: string) => push(m, 'error') }
