import { describe, it, expect } from 'vitest'
import { detectProjectType, getProjectProfile } from './projectProfiles'

describe('detectProjectType', () => {
  it('detects competitive programming', () => {
    expect(detectProjectType('Solve this Codeforces problem')).toBe('cp')
    expect(detectProjectType('Solve it', 'read from stdin, write to stdout, time limit 2s')).toBe('cp')
    expect(detectProjectType('LeetCode two-sum in a single file')).toBe('cp')
  })

  it('detects deep learning ahead of general ML', () => {
    expect(detectProjectType('Train a CNN on MNIST with PyTorch')).toBe('dl')
    expect(detectProjectType('Build a transformer', 'fine-tune embeddings for 3 epochs')).toBe('dl')
  })

  it('detects classic ML', () => {
    expect(detectProjectType('Train a model', 'use scikit-learn on the iris dataset')).toBe('ml')
    expect(detectProjectType('Build a random forest classifier with pandas')).toBe('ml')
  })

  it('detects website work', () => {
    expect(detectProjectType('Build a landing page for a coffee shop')).toBe('website')
    expect(detectProjectType('Portfolio site', 'plain HTML and CSS, no framework')).toBe('website')
    expect(detectProjectType('Scaffold a React frontend with Vite')).toBe('website')
  })

  it('falls back to node for everything else', () => {
    expect(detectProjectType('Add input validation to the CLI tool')).toBe('node')
    expect(detectProjectType('Fix the failing unit test in utils')).toBe('node')
  })

  it('cp wins over dl when both appear (most specific first)', () => {
    expect(detectProjectType('Codeforces problem about neural networks')).toBe('cp')
  })
})

describe('project profile verdicts', () => {
  it('node: only run_tests counts, and its marker decides', () => {
    const p = getProjectProfile('node')
    expect(p.verdict('run_tests', 'TESTS PASSED\n42 ok')).toBe('pass')
    expect(p.verdict('run_tests', 'TESTS FAILED\n1 failing')).toBe('fail')
    expect(p.verdict('run_cpp', 'CPP RUN OK\n')).toBeNull()
    expect(p.verdict('write_file', 'Wrote file')).toBeNull()
  })

  it('website: run_tests or a passing script both count', () => {
    const p = getProjectProfile('website')
    expect(p.verdict('run_script', 'SCRIPT OK [build]\ndone')).toBe('pass')
    expect(p.verdict('run_script', 'SCRIPT FAILED [build]\nboom')).toBe('fail')
    expect(p.verdict('run_tests', 'TESTS PASSED\n')).toBe('pass')
  })

  it('ml/dl: pytest and python smoke runs count, npm tests do not', () => {
    for (const type of ['ml', 'dl'] as const) {
      const p = getProjectProfile(type)
      expect(p.verdict('run_pytest', 'PYTEST PASSED\n3 passed')).toBe('pass')
      expect(p.verdict('run_python', 'PYTHON RUN OK [train.py --smoke]\n')).toBe('pass')
      expect(p.verdict('run_python', 'PYTHON RUN FAILED [train.py --smoke]\nTraceback')).toBe('fail')
      expect(p.verdict('run_tests', 'TESTS PASSED\n')).toBeNull()
    }
  })

  it('cp: only run_cpp counts', () => {
    const p = getProjectProfile('cp')
    expect(p.verdict('run_cpp', 'CPP RUN OK [main.cpp]\n7')).toBe('pass')
    expect(p.verdict('run_cpp', 'CPP RUN FAILED [main.cpp]\nCOMPILE ERROR')).toBe('fail')
    expect(p.verdict('run_pytest', 'PYTEST PASSED\n')).toBeNull()
  })

  it('every profile ships a prompt addendum and task hint', () => {
    for (const type of ['website', 'node', 'ml', 'dl', 'cp'] as const) {
      const p = getProjectProfile(type)
      expect(p.promptAddendum.length).toBeGreaterThan(40)
      expect(p.taskHint.length).toBeGreaterThan(20)
      expect(p.type).toBe(type)
    }
  })
})
