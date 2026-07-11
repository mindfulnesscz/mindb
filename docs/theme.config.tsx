import React from 'react'
import { DocsThemeConfig } from 'nextra-theme-docs'

const config: DocsThemeConfig = {
  logo: (
    <span style={{ fontWeight: 700, letterSpacing: '0.08em' }}>DC HUB</span>
  ),
  project: {},
  docsRepositoryBase: 'https://github.com/disruptcollective/dc-hub',
  footer: {
    text: '© Disrupt Collective — internal documentation',
  },
  head: (
    <>
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta name="robots" content="noindex" />
    </>
  ),
  useNextSeoProps() {
    return { titleTemplate: '%s — DC Hub Docs' }
  },
}

export default config
