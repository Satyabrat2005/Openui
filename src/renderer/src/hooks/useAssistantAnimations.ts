import { useEffect, type MutableRefObject, type RefObject } from 'react'
import gsap from 'gsap'

/**
 * Recreates the GSAP behaviour from design.html for the floating popups:
 *   • entrance choreography for #openui-popup and #task-popup
 *   • mic pulse rings (staggered outward wave, looping)
 *   • sound bars (stochastic bounce while "listening", looping)
 *   • caption typewriter (demo mode until captionLockedRef becomes true)
 *
 * recordingRef   — set to true by AssistantPopup while the mic is active.
 *                  The bar tick skips new tweens so the rAF-driven real-audio
 *                  animation can write heights uncontested.
 *
 * captionLockedRef — set to true by AssistantPopup when it takes over
 *                    #caption-text. The typewriter step returns early so React
 *                    state can manage the element without fighting GSAP.
 */

const CAPTION =
  'Join the 11 AM strategy meet, take notes, then open my current project in VS Code and check off the task list when done.'
const CHAR_MS = 55

const RING_CFG = [
  { id: '#ring-1', toScale: 1.65, dur: 1.75, delay: 0.0 },
  { id: '#ring-2', toScale: 1.46, dur: 1.75, delay: 0.46 },
  { id: '#ring-3', toScale: 1.28, dur: 1.75, delay: 0.92 }
] as const

export function useAssistantAnimations(
  scopeRef: RefObject<HTMLElement>,
  recordingRef?: MutableRefObject<boolean>,
  captionLockedRef?: MutableRefObject<boolean>
): void {
  useEffect(() => {
    const scope = scopeRef.current
    if (!scope) return

    let barTimer: number | null = null
    let typeTimer: number | null = null
    const ringTweens: gsap.core.Tween[] = []

    // ── Sound bars: stochastic bounce, paused while mic is live ──────────
    const startBars = (): void => {
      const bars = scope.querySelectorAll<HTMLElement>('.sbar')
      const tick = (): void => {
        if (recordingRef?.current) {
          // Real-audio rAF loop is active; reschedule without touching bars.
          barTimer = window.setTimeout(tick, 100)
          return
        }
        bars.forEach((bar) => {
          gsap.to(bar, {
            height: Math.floor(Math.random() * 16) + 3 + 'px',
            duration: 0.14 + Math.random() * 0.12,
            ease: 'power1.inOut'
          })
        })
        barTimer = window.setTimeout(tick, 150 + Math.floor(Math.random() * 90))
      }
      tick()
    }

    // ── Mic pulse rings: staggered, infinitely repeating outward wave ────
    const startRings = (): void => {
      RING_CFG.forEach((cfg) => {
        const el = scope.querySelector<HTMLElement>(cfg.id)
        if (!el) return
        gsap.set(el, { scale: 1, opacity: 1, transformOrigin: '50% 50%' })
        ringTweens.push(
          gsap.to(el, {
            scale: cfg.toScale,
            opacity: 0,
            transformOrigin: '50% 50%',
            duration: cfg.dur,
            delay: cfg.delay,
            repeat: -1,
            repeatDelay: 0.12,
            ease: 'power1.out'
          })
        )
      })
    }

    // ── Typewriter caption (demo mode) ───────────────────────────────────
    // Stops immediately when captionLockedRef becomes true so AssistantPopup
    // can take sole ownership of #caption-text.
    const typeWriter = (el: HTMLElement, text: string, charMs: number): void => {
      el.textContent = ''
      let i = 0
      const step = (): void => {
        if (captionLockedRef?.current) return // AssistantPopup has taken over
        if (i < text.length) {
          el.textContent += text.charAt(i++)
          typeTimer = window.setTimeout(step, charMs)
        }
      }
      step()
    }

    // ── Main entrance timeline (scoped to the overlay) ───────────────────
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: 'expo.out' } })

      tl.fromTo(
        '#openui-popup',
        { opacity: 0, scale: 0.94, y: 14 },
        { opacity: 1, scale: 1, y: 0, duration: 0.9 },
        0.2
      )

      tl.fromTo('#task-popup', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.65 }, 1.1)

      tl.add(() => startRings(), 1.0)
      tl.add(() => startBars(), 1.2)

      tl.add(() => {
        const cap = scope.querySelector<HTMLElement>('#caption-text')
        if (cap) typeWriter(cap, CAPTION, CHAR_MS)
      }, 1.6)
    }, scope)

    return () => {
      if (barTimer !== null) clearTimeout(barTimer)
      if (typeTimer !== null) clearTimeout(typeTimer)
      ringTweens.forEach((t) => t.kill())
      gsap.killTweensOf(scope.querySelectorAll('.sbar'))
      ctx.revert()
    }
  }, [scopeRef])
}
