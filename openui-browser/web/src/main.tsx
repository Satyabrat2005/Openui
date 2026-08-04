import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css' // ← copied VERBATIM from the desktop renderer (tokens + fonts + ou-rc)
import './signin.css'
import App from './App'

// The desktop app sets data-theme on <html>; default to dark (the console's
// primary look, matching the verification baseline).
document.documentElement.dataset.theme ??= 'dark'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
