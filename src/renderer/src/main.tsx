import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// Note: no <React.StrictMode> here on purpose — Strict Mode double-invokes
// effects in development, which would fire the GSAP entrance timeline twice.
createRoot(document.getElementById('root') as HTMLElement).render(<App />)
