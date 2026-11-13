import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OpencodeModelSelector } from './OpencodeModelSelector'

vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe('stock HAPI OpenCode model selector', () => {
  it('shows and selects PAC and native models without altering their IDs', () => {
    const change = vi.fn()
    render(<OpencodeModelSelector cwd="C:\\project" machineId="existing-machine" isLoading={false} error={null}
      currentModelId={null} selectedModel={null} onModelChange={change}
      availableModels={[
        { modelId: 'PAC_primary/opus', name: 'PAC #1 / Claude Opus 5.5' },
        { modelId: 'PAC_primary/codex', name: 'PAC #1 / Codex' },
        { modelId: 'native/model', name: 'Native model' },
      ]} />)
    const select = screen.getByTestId('opencode-model-list')
    expect(screen.getByRole('option', { name: 'PAC #1 / Claude Opus 5.5' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'PAC #1 / Codex' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Native model' })).toBeTruthy()
    fireEvent.change(select, { target: { value: 'PAC_primary/opus' } })
    expect(change).toHaveBeenLastCalledWith('PAC_primary/opus')
    fireEvent.change(select, { target: { value: 'PAC_primary/codex' } })
    expect(change).toHaveBeenLastCalledWith('PAC_primary/codex')
  })
})
