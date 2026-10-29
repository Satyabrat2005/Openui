import { describe, it, expect } from 'vitest'
import type { TaskCard } from '../env'
import { poseForText, poseForRuns, DONE_LINGER_MS, POSE_CAPTION } from './buddyPose'

function run(p: Partial<TaskCard>): TaskCard {
  return { id: 'r', title: 'Task', status: 'in_progress', kind: 'chat', steps: [], groups: [], startedAt: 0, ...p } as TaskCard
}

describe('poseForText', () => {
  it('reading / writing / summarising tasks sit down with the notepad', () => {
    expect(poseForText('Summarize my Slack channel', 'do')).toBe('write')
    expect(poseForText('what did I miss today?', 'do')).toBe('write')
    expect(poseForText('Reply to Mom on WhatsApp: on my way', 'do')).toBe('write')
  })
  it('coding / building / executing tasks open the laptop', () => {
    expect(poseForText('build me a landing page', 'do')).toBe('code')
    expect(poseForText('execute the backup script', 'ask')).toBe('code')
  })
  it('anything else follows the Answer/Act toggle', () => {
    expect(poseForText('book a table for two', 'do')).toBe('work')
    expect(poseForText('how tall is Everest?', 'ask')).toBe('write')
  })
})

describe('poseForRuns', () => {
  it('sleeps when nothing has run', () => {
    expect(poseForRuns([], {}, 1000)).toBe('sleep')
  })
  it('an in-progress run decides the pose, using the mode it was started with', () => {
    const r = run({ title: 'how tall is Everest?' })
    expect(poseForRuns([r], { 'how tall is Everest?': 'ask' }, 0)).toBe('write')
    expect(poseForRuns([r], {}, 0)).toBe('work') // unknown mode → Act
  })
  it('celebrates briefly after the latest run ends, then dozes off', () => {
    const r = run({ status: 'done', endedAt: 10_000 })
    expect(poseForRuns([r], {}, 10_000 + DONE_LINGER_MS - 1)).toBe('done')
    expect(poseForRuns([r], {}, 10_000 + DONE_LINGER_MS)).toBe('sleep')
  })
  it('the idle caption is the design greeting', () => {
    expect(POSE_CAPTION.sleep).toBe('Your wish is my command!')
  })
})
