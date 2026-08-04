import { useState } from 'react'
import { WebAuthProvider } from './context/WebAuthContext'
import { WebTaskActivityProvider } from './context/WebTaskActivityContext'
import RunConsole from './components/RunConsole'
import SignIn from './components/SignIn'
import { getToken } from './api'

// The web front door: sign in → the Run Console. The desktop app boots straight
// into the console (it's already authenticated at the OS level); the browser
// product gates on sign-in first (new surface), then renders the SAME console.
export default function App(): JSX.Element {
  const [authed, setAuthed] = useState(() => !!getToken())
  const [historyOpen, setHistoryOpen] = useState(false)

  if (!authed) return <SignIn onSignedIn={() => setAuthed(true)} />

  return (
    <WebAuthProvider>
      <WebTaskActivityProvider>
        <RunConsole historyOpen={historyOpen} onHistoryChange={setHistoryOpen} />
      </WebTaskActivityProvider>
    </WebAuthProvider>
  )
}
