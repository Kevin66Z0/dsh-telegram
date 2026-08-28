/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-telegram`.
 * @module @deepseek-ai/dsh-host-telegram/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-telegram'

/** Cordis companion plugin name. */
export const name = 'telegram-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this remote-control surface owns no durable
 * package-local event stream, projection, or registry state. Its config is
 * schema-validated at load, its bindings are process-lifetime chat state
 * owned by one long-poll effect, and its only durable write is the user
 * prompt it routes through the host ApiProxy — a relationship the ApiProxy
 * and session packages already assert. Boundary, access-gate, and disposal
 * behavior is covered by unit tests instead.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
