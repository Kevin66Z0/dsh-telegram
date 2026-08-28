/**
 * Companion registration: the explained-empty installer must mount and
 * dispose cleanly on a context with the invariants registry.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as TelegramInvariant from '../src/invariant.ts'

describe('telegram invariant companion', () => {
  it('registers under the package name on a registry context', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(TelegramInvariant).then(() => undefined)).resolves.toBeUndefined()
  })

  it('exports the companion contract', () => {
    expect(TelegramInvariant.name).toBe('telegram-invariant')
    expect(TelegramInvariant.inject).toEqual(['invariants'])
  })
})
