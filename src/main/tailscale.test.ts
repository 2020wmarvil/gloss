import { describe, expect, it } from 'vitest'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tailscaleCert, tailscaleCli, tailscaleStatus } from './tailscale'

const status = (s: object) => async () => JSON.stringify(s)

describe('tailscaleStatus', () => {
  it('reads the certificate name and the IPv4 address', async () => {
    const info = await tailscaleStatus('ts', status({
      BackendState: 'Running',
      CertDomains: ['my-pc.tail1234.ts.net'],
      Self: { HostName: 'my-pc', TailscaleIPs: ['100.64.0.7', 'fd7a:115c:a1e0::1'] }
    }))
    expect(info).toEqual({ host: 'my-pc.tail1234.ts.net', ip: '100.64.0.7', machine: 'my-pc' })
  })

  it('says what to do when Tailscale is missing, stopped or has no certificates', async () => {
    const missing = async () => { throw Object.assign(new Error('spawn'), { code: 'ENOENT' }) }
    await expect(tailscaleStatus('ts', missing)).rejects.toThrow("Tailscale isn't installed")
    const stopped = async () => { throw new Error('failed to connect to local tailscaled') }
    await expect(tailscaleStatus('ts', stopped)).rejects.toThrow("Tailscale isn't running")
    await expect(tailscaleStatus('ts', status({ BackendState: 'NeedsLogin' }))).rejects.toThrow('NeedsLogin')
    await expect(tailscaleStatus('ts', status({ BackendState: 'Running', CertDomains: null, Self: {} }))).rejects.toThrow('HTTPS Certificates')
  })

  it('looks for the CLI in Program Files on Windows, else on the PATH', () => {
    expect(tailscaleCli({}, 'linux')).toBe('tailscale')
  })
})

describe('tailscaleCert', () => {
  it('asks for at least 30 days of validity and reads the expiry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gloss-cert-'))
    const fixture = readFileSync(join(__dirname, 'fixtures', 'bridge-a-cert.pem'))
    let args: string[] = []
    const cert = await tailscaleCert('my-pc.tail1234.ts.net', dir, 'ts', async (_cli, a) => {
      args = a
      writeFileSync(a[a.indexOf('--cert-file') + 1], fixture)
      writeFileSync(a[a.indexOf('--key-file') + 1], 'key')
      return ''
    })
    expect(args.slice(0, 3)).toEqual(['cert', '--min-validity', '720h'])
    expect(args.at(-1)).toBe('my-pc.tail1234.ts.net')
    expect(cert.expiresAt).toBe(Date.parse(new X509Certificate(fixture).validTo))
  })
})
