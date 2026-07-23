// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { useResizable } from '../Splitter'

function ResizeProbe({ invert = false }: { invert?: boolean }) {
  const split = useResizable({
    initial: 200,
    min: 100,
    max: 400,
    direction: 'horizontal',
    invert,
  })

  return (
    <div>
      <span data-testid="size">{split.size}</span>
      <button type="button" data-testid="handle" onMouseDown={split.onMouseDown}>
        drag
      </button>
    </div>
  )
}

describe('useResizable sidebar direction', () => {
  test('increases width when dragging right in normal mode', () => {
    render(<ResizeProbe />)

    fireEvent.mouseDown(screen.getByTestId('handle'), { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 150 })
    fireEvent.mouseUp(window)

    expect(screen.getByTestId('size')).toHaveTextContent('250')
  })

  test('decreases width when dragging right in inverted mode', () => {
    render(<ResizeProbe invert />)

    fireEvent.mouseDown(screen.getByTestId('handle'), { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 150 })
    fireEvent.mouseUp(window)

    expect(screen.getByTestId('size')).toHaveTextContent('150')
  })
})
