import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
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
  it('asks for at least 30 days of validity, and says when Tailscale can\'t issue one', async () => {
    let args: string[] = []
    const failing = async (_cli: string, a: string[]): Promise<string> => {
      args = a
      throw Object.assign(new Error('exit 1'), { stderr: 'certificates are not enabled for this tailnet' })
    }
    await expect(tailscaleCert('my-pc.tail1234.ts.net', tmpdir(), 'ts', failing)).rejects.toThrow('certificates are not enabled')
    expect(args.slice(0, 3)).toEqual(['cert', '--min-validity', '720h'])
    expect(args.at(-1)).toBe('my-pc.tail1234.ts.net')
  })
})
