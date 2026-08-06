import { describe, expect, it } from 'vitest'
import { describeBackend, projectRef } from './buildInfo'

describe('describeBackend', () => {
  it('names the production project', () => {
    expect(describeBackend('https://knbxyaplaoenrxrpgwcg.supabase.co')).toEqual({
      label: 'Production',
      tone: 'production',
    })
  })

  it('names the staging project', () => {
    expect(describeBackend('https://tvrxnwbhzborkkkdeyuk.supabase.co')).toEqual({
      label: 'Staging',
      tone: 'staging',
    })
  })

  it('recognises a local stack', () => {
    expect(describeBackend('http://localhost:54321').tone).toBe('local')
    expect(describeBackend('http://127.0.0.1:54321').tone).toBe('local')
  })

  it('never claims production for an unrecognised backend', () => {
    const unknown = describeBackend('https://abcdefghijklmnop.supabase.co')
    expect(unknown.tone).not.toBe('production')
    // Naming the ref keeps two unknown deployments distinguishable.
    expect(unknown.label).toBe('abcdefghijklmnop')
  })

  it('handles an unconfigured portal without pretending it is live', () => {
    expect(describeBackend('')).toEqual({ label: 'Not configured', tone: 'staging' })
  })
})

describe('projectRef', () => {
  it('extracts the ref from a Supabase URL', () => {
    expect(projectRef('https://knbxyaplaoenrxrpgwcg.supabase.co')).toBe('knbxyaplaoenrxrpgwcg')
    expect(projectRef('https://knbxyaplaoenrxrpgwcg.supabase.co/')).toBe('knbxyaplaoenrxrpgwcg')
  })
})
