import { useState } from 'react'
import type { BuddyPose } from '../lib/buddyPose'

/**
 * SplenBuddy — the line-art character on the home screen.
 *
 * Pure inline SVG + CSS keyframes (no animation library, nothing fetched — the
 * CSP is 'self' only). Limbs are drawn with an "outline stroke" trick: every
 * limb path is stroked wide in the ink colour, then again narrower in the page
 * background, so overlapping limbs merge into one outlined doodle the way the
 * reference illustration looks. The pose is decided by lib/buddyPose from real
 * run state; this component only draws it.
 *
 * A small random variant (accent colour, hair) is picked once per app open, so
 * the sleeping Splen looks slightly different each launch.
 */

type Limb = { d: string; w: number }

const ACCENTS = ['#2f8fe0', '#e2b567', '#5fbf95'] as const

function Limbs({ limbs }: { limbs: Limb[] }): JSX.Element {
  return (
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      {limbs.map((l, i) => (
        <path key={`o${i}`} d={l.d} stroke="currentColor" strokeWidth={l.w} />
      ))}
      {limbs.map((l, i) => (
        <path key={`i${i}`} d={l.d} stroke="var(--ou-sp-bg)" strokeWidth={l.w - 3.6} />
      ))}
    </g>
  )
}

function Head({ cx, cy, hair }: { cx: number; cy: number; hair: number }): JSX.Element {
  const curly = `M${cx - 12} ${cy - 5} q2 -9 9 -8 q4 -7 11 -2 q8 -1 6 8`
  const spiky = `M${cx - 12} ${cy - 4} l3 -10 l4 6 l4 -9 l4 8 l5 -6 l1 9`
  return (
    <g>
      <circle cx={cx} cy={cy} r={14} fill="var(--ou-sp-bg)" stroke="currentColor" strokeWidth={2.2} />
      <path d={hair === 0 ? curly : spiky} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  )
}

function Grass(): JSX.Element {
  const tufts = [36, 92, 150, 214]
  return (
    <g className="ou-sp-grass" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      {tufts.map((x) => (
        <path key={x} d={`M${x} 114 l-3 -6 M${x + 5} 114 l0 -7 M${x + 10} 114 l3 -6`} />
      ))}
    </g>
  )
}

function Sleep({ accent, hair }: { accent: string; hair: number }): JSX.Element {
  return (
    <g>
      <Grass />
      <g className="ou-sp-breathe">
        <Limbs
          limbs={[
            { d: 'M118 100 L186 86', w: 22 },
            { d: 'M118 100 L90 70 L74 104 L64 106', w: 11 },
            { d: 'M118 103 L56 107 L48 104', w: 11 },
            { d: 'M180 84 L196 62 L214 66', w: 9 }
          ]}
        />
        {/* Blanket over the torso — its colour is the per-launch variant. */}
        <path
          d="M112 92 Q150 78 190 77 L192 97 Q150 104 110 110 Z"
          fill={accent}
          fillOpacity={0.85}
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        <Head cx={206} cy={80} hair={hair} />
        <path d="M200 82 q3 2.5 6 0" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
        <path d="M209 88 q2 1 4 0" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
      </g>
      <g className="ou-sp-zzz" fill="currentColor" fontFamily="var(--ou-font)" fontWeight={600}>
        <text x={224} y={56} fontSize={11} style={{ animationDelay: '0s' }}>z</text>
        <text x={232} y={44} fontSize={13} style={{ animationDelay: '0.9s' }}>z</text>
        <text x={241} y={30} fontSize={16} style={{ animationDelay: '1.8s' }}>Z</text>
      </g>
    </g>
  )
}

function Write({ accent, hair }: { accent: string; hair: number }): JSX.Element {
  return (
    <g>
      <Grass />
      <Limbs
        limbs={[
          { d: 'M118 96 L122 58', w: 22 },
          { d: 'M94 106 Q122 90 150 106', w: 11 },
          { d: 'M114 66 L128 86 L142 80', w: 9 }
        ]}
      />
      {/* Notepad */}
      <g transform="rotate(-12 153 70)">
        <rect x={140} y={54} width={26} height={32} rx={3} fill={accent} fillOpacity={0.9} stroke="currentColor" strokeWidth={2} />
        <path d="M145 63 H161 M145 69 H161 M145 75 H156" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
      </g>
      {/* Writing arm + pencil scribble together. */}
      <g className="ou-sp-scribble">
        <Limbs limbs={[{ d: 'M126 64 L144 76 L156 72', w: 9 }]} />
        <path d="M156 72 L166 60" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
      </g>
      <Head cx={122} cy={40} hair={hair} />
      {/* Glasses */}
      <g fill="none" stroke="currentColor" strokeWidth={1.6}>
        <circle cx={118} cy={42} r={4.2} />
        <circle cx={128.5} cy={42} r={4.2} />
        <path d="M122.2 42 H124.3 M113.8 41 L110 39" strokeLinecap="round" />
      </g>
      <path d="M121 50 H126" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
      <g className="ou-sp-think" fill="currentColor">
        <circle cx={142} cy={24} r={2} style={{ animationDelay: '0s' }} />
        <circle cx={150} cy={18} r={2.6} style={{ animationDelay: '0.3s' }} />
        <circle cx={159} cy={11} r={3.2} style={{ animationDelay: '0.6s' }} />
      </g>
    </g>
  )
}

function Code({ accent, hair }: { accent: string; hair: number }): JSX.Element {
  return (
    <g>
      <Grass />
      <Limbs
        limbs={[
          { d: 'M112 96 L116 58', w: 22 },
          { d: 'M90 106 Q114 92 140 106', w: 11 }
        ]}
      />
      {/* Laptop */}
      <path d="M140 98 L150 62 L188 62 L180 98 Z" fill="var(--ou-sp-bg)" stroke="currentColor" strokeWidth={2.2} strokeLinejoin="round" />
      <g className="ou-sp-codelines" stroke={accent} strokeWidth={2} strokeLinecap="round">
        <path d="M154 72 H170" style={{ animationDelay: '0s' }} />
        <path d="M152 79 H176" style={{ animationDelay: '0.25s' }} />
        <path d="M150 86 H166" style={{ animationDelay: '0.5s' }} />
      </g>
      <path d="M130 100 L188 100" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
      <g className="ou-sp-type">
        <Limbs
          limbs={[
            { d: 'M112 68 L128 90 L142 97', w: 9 },
            { d: 'M118 66 L136 86 L150 94', w: 9 }
          ]}
        />
      </g>
      <Head cx={118} cy={40} hair={hair} />
      <circle cx={123} cy={40} r={1.6} fill="currentColor" />
      <circle cx={130} cy={40} r={1.6} fill="currentColor" />
      <path d="M123 49 q3 1.5 6 0" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
      <g className="ou-sp-particles" fill={accent} fontFamily="var(--ou-font-mono)" fontSize={10} fontWeight={600}>
        <text x={186} y={54} style={{ animationDelay: '0s' }}>{'</>'}</text>
        <text x={202} y={70} style={{ animationDelay: '0.7s' }}>{'{ }'}</text>
        <text x={170} y={46} style={{ animationDelay: '1.4s' }}>01</text>
        <text x={208} y={48} style={{ animationDelay: '2.1s' }}>{'=>'}</text>
      </g>
    </g>
  )
}

function Work({ accent, hair }: { accent: string; hair: number }): JSX.Element {
  return (
    <g>
      <Grass />
      <g className="ou-sp-motion" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
        <path d="M44 58 H84" />
        <path d="M32 74 H80" />
        <path d="M48 90 H88" />
      </g>
      <g className="ou-sp-bob">
        <Limbs
          limbs={[
            { d: 'M130 64 L114 76 L102 70', w: 9 },
            { d: 'M122 90 L104 100 L90 94', w: 11 },
            { d: 'M122 90 L136 56', w: 22 },
            { d: 'M122 90 L144 98 L152 112', w: 11 },
            { d: 'M132 62 L150 70 L162 58', w: 9 }
          ]}
        />
        {/* A little flag in hand — "on a mission". */}
        <path d="M162 58 L166 34" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" />
        <path d="M166 34 L182 39 L165 45 Z" fill={accent} stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" />
        <Head cx={142} cy={38} hair={hair} />
        <circle cx={148} cy={38} r={1.6} fill="currentColor" />
        <path d="M145 46 H151" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
      </g>
    </g>
  )
}

function Done({ accent, hair }: { accent: string; hair: number }): JSX.Element {
  return (
    <g>
      <Grass />
      <g className="ou-sp-cheer">
        <Limbs
          limbs={[
            { d: 'M130 98 L118 113', w: 11 },
            { d: 'M130 98 L142 113', w: 11 },
            { d: 'M130 98 L130 62', w: 22 },
            { d: 'M126 68 L110 52 L106 34', w: 9 },
            { d: 'M134 68 L150 52 L154 34', w: 9 }
          ]}
        />
        <Head cx={130} cy={44} hair={hair} />
        <path d="M125 42 q2 -2 4 0 M132 42 q2 -2 4 0" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
        <path d="M124 49 q6 5 12 0" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
      </g>
      <circle cx={182} cy={46} r={12} fill={accent} stroke="currentColor" strokeWidth={2} />
      <path d="M176 46 l4 4 l8 -8" fill="none" stroke="var(--ou-sp-bg)" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
      <g className="ou-sp-sparkle" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
        <path d="M84 40 v8 M80 44 h8" style={{ animationDelay: '0s' }} />
        <path d="M202 24 v6 M199 27 h6" style={{ animationDelay: '0.5s' }} />
        <path d="M96 70 v6 M93 73 h6" style={{ animationDelay: '1s' }} />
      </g>
    </g>
  )
}

const POSES: Record<BuddyPose, (p: { accent: string; hair: number }) => JSX.Element> = {
  sleep: Sleep,
  write: Write,
  code: Code,
  work: Work,
  done: Done
}

export default function SplenBuddy({ pose, compact = false }: { pose: BuddyPose; compact?: boolean }): JSX.Element {
  // Picked once per mount (= once per app open): the "randomised details".
  const [variant] = useState(() => ({
    accent: ACCENTS[Math.floor(Math.random() * ACCENTS.length)],
    hair: Math.random() < 0.5 ? 0 : 1
  }))
  const Pose = POSES[pose]
  return (
    <div className={`ou-sp-buddy${compact ? ' compact' : ''}`} data-pose={pose} aria-hidden="true">
      {/* key={pose} remounts the drawing so the enter animation plays on every change. */}
      <svg key={pose} className="ou-sp-buddy-svg" viewBox="20 0 240 124" role="presentation">
        <Pose accent={variant.accent} hair={variant.hair} />
      </svg>
    </div>
  )
}
