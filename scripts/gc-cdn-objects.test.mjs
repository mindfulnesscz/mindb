import { describe, expect, it } from 'vitest'
import {
  assertBlastRadius,
  assertReferenceSafety,
  buildReferenceIndex,
  buildReport,
  classifyObjects,
  deleteOrphans,
  parseArgs,
  parseStoredReference,
} from './gc-cdn-objects.mjs'
import {
  buildReferenceIndex as buildSharedReferenceIndex,
  buildReport as buildSharedReport,
  classifyObjects as classifySharedObjects,
} from '../packages/domain/src/cdnGarbageCollection.ts'

const CLIENT = '8f3e1c2a-0000-4000-8000-000000000001'
const PUBLIC_DOMAIN = 'https://cdn.example.test'
const GATED_DOMAIN = 'https://files.example.test'
const PUBLIC_BUCKET = 'sotto-public-test'
const GATED_BUCKET = 'sotto-gated-test'

function asset(overrides = {}) {
  return {
    id: 'row-live',
    client_id: CLIENT,
    stable_id: 'a1000001',
    child_id: 'c1',
    perm: 'client',
    status: 'published',
    thumbnail_url: `${GATED_DOMAIN}/client/${CLIENT}/thumbnails/a1000001/c1.webp?v=abc`,
    download_url: `${GATED_DOMAIN}/client/${CLIENT}/originals/a1000001/c1.pdf?v=abc`,
    download_key: `client/${CLIENT}/originals/a1000001/c1.pdf`,
    preview_page_count: 1,
    ...overrides,
  }
}

function object(tier, key, size = 1) {
  return {
    tier,
    bucket: tier === 'public' ? PUBLIC_BUCKET : GATED_BUCKET,
    key,
    size,
    lastModified: '2026-08-05T12:00:00.000Z',
  }
}

function indexFor(rows, options = {}) {
  return buildReferenceIndex(rows, {
    publicDomain: PUBLIC_DOMAIN,
    gatedDomain: GATED_DOMAIN,
    ...options,
  })
}

function reportFor(classified, index) {
  return buildReport({
    environment: 'staging',
    config: {
      projectRef: 'test-project',
      publicBucket: PUBLIC_BUCKET,
      gatedBucket: GATED_BUCKET,
    },
    index,
    classified,
    options: { minRows: 1 },
    generatedAt: '2026-08-05T12:00:00.000Z',
  })
}

describe('CDN garbage-collection reference model', () => {
  it('keeps the CLI-compatible fixture identical to the shared Admin classification', () => {
    const rows = [asset()]
    const inventory = [
      object('gated', `client/${CLIENT}/thumbnails/a1000001/c1.webp`, 10),
      object('public', `${CLIENT}/thumbnails/deadbeef/c9.webp`, 7),
      object('public', `branding/${CLIENT}/logo.svg`, 5),
    ]
    const cliIndex = indexFor(rows)
    const sharedIndex = buildSharedReferenceIndex(rows, {
      publicDomain: PUBLIC_DOMAIN,
      gatedDomain: GATED_DOMAIN,
    })
    const cliClassified = classifyObjects(inventory, cliIndex)
    const sharedClassified = classifySharedObjects(inventory, sharedIndex)
    expect(sharedClassified).toEqual(cliClassified)
    expect(buildSharedReport({
      environment: 'staging',
      config: { projectRef: 'test-project', publicBucket: PUBLIC_BUCKET, gatedBucket: GATED_BUCKET },
      index: sharedIndex,
      classified: sharedClassified,
      options: { minRows: 1 },
      generatedAt: '2026-08-05T12:00:00.000Z',
    })).toEqual(reportFor(cliClassified, cliIndex))
  })

  it('protects legacy R2 paths on old domains while leaving Stream URLs out of scope', () => {
    expect(
      parseStoredReference('https://old-cdn.example.test/thumbnails/deadbeef/c1.webp', {
        publicDomain: PUBLIC_DOMAIN,
        gatedDomain: GATED_DOMAIN,
      }),
    ).toMatchObject({
      tier: 'public',
      key: 'thumbnails/deadbeef/c1.webp',
      source: 'inferred-legacy-old-domain',
    })
    expect(
      parseStoredReference(
        'https://customer-example.cloudflarestream.com/video-id/thumbnails/thumbnail.jpg',
        { publicDomain: PUBLIC_DOMAIN, gatedDomain: GATED_DOMAIN },
      ),
    ).toMatchObject({ outOfScope: true })
  })

  it('classifies the seeded fixture without offering any live or protected object for deletion', () => {
    const index = indexFor([asset()])
    assertReferenceSafety(index, { minRows: 1 })

    const classified = classifyObjects(
      [
        object('gated', `client/${CLIENT}/thumbnails/a1000001/c1.webp`, 10),
        object('gated', `client/${CLIENT}/originals/a1000001/c1.pdf`, 100),
        object('gated', `client/${CLIENT}/pages/a1000001/c1/001.webp`, 20),
        object('public', `${CLIENT}/thumbnails/a1000001/c1.webp`, 10),
        object('public', `${CLIENT}/originals/a1000001/c1.pdf`, 100),
        object('public', `branding/${CLIENT}/logo.svg`, 5),
        object('public', `${CLIENT}/thumbnails/deadbeef/c9.webp`, 7),
      ],
      index,
    )

    expect(classified.find(item => item.key.includes('/pages/'))?.status).toBe('referenced')
    expect(classified.find(item => item.key.startsWith('branding/'))).toMatchObject({
      status: 'protected',
      namespace: 'branding',
    })
    expect(
      classified.find(item => item.key === `${CLIENT}/thumbnails/a1000001/c1.webp`),
    ).toMatchObject({
      status: 'orphan',
      reason: 'old-level-copy',
    })
    expect(
      classified.find(item => item.key === `${CLIENT}/originals/a1000001/c1.pdf`),
    ).toMatchObject({
      status: 'orphan',
      reason: 'old-level-copy',
    })
    expect(classified.find(item => item.key.includes('/deadbeef/'))).toMatchObject({
      status: 'orphan',
      reason: 'no-matching-row',
    })
  })

  it('protects any original extension by canonical prefix when the row cannot reconstruct one', () => {
    const row = asset({
      id: 'row-no-extension',
      stable_id: 'a2000002',
      child_id: 'c4',
      thumbnail_url: null,
      download_url: null,
      download_key: null,
      preview_page_count: 0,
    })
    const classified = classifyObjects(
      [object('gated', `client/${CLIENT}/originals/a2000002/c4.indd`, 90)],
      indexFor([row]),
    )
    expect(classified[0]).toMatchObject({
      status: 'referenced',
      referenceType: 'live-original-prefix',
    })
  })

  it('protects disconnected references by default and exposes them only with the explicit flag', () => {
    const row = asset({
      id: 'row-disconnected',
      status: 'disconnected',
      thumbnail_url: `${GATED_DOMAIN}/internal/${CLIENT}/thumbnails/a1000001/c1.webp`,
      download_url: null,
      download_key: null,
      preview_page_count: 0,
    })
    const disconnectedThumb = object('gated', `internal/${CLIENT}/thumbnails/a1000001/c1.webp`, 12)

    const protectedResult = classifyObjects([disconnectedThumb], indexFor([row]))
    expect(protectedResult[0]).toMatchObject({
      status: 'referenced',
      disconnectedReference: true,
    })

    const droppedResult = classifyObjects(
      [disconnectedThumb],
      indexFor([row], { dropDisconnected: true }),
    )
    expect(droppedResult[0]).toMatchObject({
      status: 'orphan',
      reason: 'no-matching-row',
      fromDisconnected: true,
    })
  })

  it('requires an explicit opt-in before branding can become a candidate', () => {
    const branding = object('public', `branding/${CLIENT}/logo.png`, 5)
    const index = indexFor([asset()])
    expect(classifyObjects([branding], index)[0].status).toBe('protected')
    expect(classifyObjects([branding], index, { includeProtected: ['branding'] })[0]).toMatchObject(
      {
        status: 'orphan',
        reason: 'unknown-shape',
        namespace: 'branding',
      },
    )
  })
})

describe('CDN garbage-collection destructive rails', () => {
  it('aborts an empty or implausibly small reference source', () => {
    expect(() => assertReferenceSafety(indexFor([]), { minRows: 1 })).toThrow(
      /returned zero asset rows/,
    )
    expect(() => assertReferenceSafety(indexFor([asset()]), { minRows: 2 })).toThrow(
      /below the sane floor/,
    )
  })

  it('fires the blast-radius gate above 60% unless force is explicit', () => {
    const index = indexFor([asset()])
    const classified = classifyObjects(
      [
        object('gated', `client/${CLIENT}/thumbnails/a1000001/c1.webp`),
        object('public', `${CLIENT}/thumbnails/deadbeef/c8.webp`),
        object('public', `${CLIENT}/thumbnails/deadbeef/c9.webp`),
      ],
      index,
    )
    const report = reportFor(classified, index)
    expect(report.safety.orphanFraction).toBeCloseTo(2 / 3)
    expect(() => assertBlastRadius(report)).toThrow(/blast-radius abort/)
    expect(() => assertBlastRadius(report, { force: true })).not.toThrow()
  })

  it('execute deletes only orphan candidates and never referenced/protected entries', async () => {
    const index = indexFor([asset()])
    const classified = classifyObjects(
      [
        object('gated', `client/${CLIENT}/thumbnails/a1000001/c1.webp`, 10),
        object('public', `branding/${CLIENT}/logo.svg`, 5),
        object('public', `${CLIENT}/thumbnails/a1000001/c1.webp`, 11),
        object('public', `${CLIENT}/thumbnails/deadbeef/c9.webp`, 12),
      ],
      index,
    )
    const batches = []
    const audited = []
    const result = await deleteOrphans(classified, {
      deleteBatch: async batch => {
        batches.push(batch.map(item => item.key))
        return batch.map(item => item.key)
      },
      onDeleted: async item => audited.push(item.key),
      batchSize: 1,
    })

    expect(batches.flat().sort()).toEqual(
      [`${CLIENT}/thumbnails/a1000001/c1.webp`, `${CLIENT}/thumbnails/deadbeef/c9.webp`].sort(),
    )
    expect(audited.sort()).toEqual(batches.flat().sort())
    expect(result).toEqual({ deleted: 2, deletedBytes: 23, planned: 2 })
  })

  it('audits confirmed keys before surfacing a partial batch failure', async () => {
    const index = indexFor([asset()])
    const classified = classifyObjects(
      [
        object('public', `${CLIENT}/thumbnails/deadbeef/c8.webp`, 8),
        object('public', `${CLIENT}/thumbnails/deadbeef/c9.webp`, 9),
      ],
      index,
    )
    const audited = []
    await expect(
      deleteOrphans(classified, {
        deleteBatch: async batch => ({
          deletedKeys: [batch[0].key],
          failures: [{ key: batch[1].key, code: 'SlowDown', message: 'retry later' }],
        }),
        onDeleted: async item => audited.push(item.key),
      }),
    ).rejects.toThrow(/confirmed deletions were audited/)
    expect(audited).toEqual([`${CLIENT}/thumbnails/deadbeef/c8.webp`])
  })

  it('requires the named environment and dry-runs unless execute is explicit', () => {
    expect(() => parseArgs([])).toThrow(/--env is required/)
    expect(parseArgs(['--env', 'staging'])).toMatchObject({
      environment: 'staging',
      execute: false,
      dropDisconnected: false,
    })
    expect(parseArgs(['--env', 'production', '--execute', '--yes'])).toMatchObject({
      environment: 'production',
      execute: true,
      yes: true,
    })
  })
})
