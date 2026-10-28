import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'

// The phone reaches Gloss over Tailscale, with the certificate Tailscale issues for the machine's
// name (SPEC → Remote and mobile). Errors here are shown in Settings → Phone as they are.

export type TailscaleInfo = { host: string; ip: string; machine: string }
export type Certificate = { cert: Buffer; key: Buffer; expiresAt: number }
export type Run = (file: string, args: string[]) => Promise<string>

const run: Run = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }))
      else resolve(String(stdout))
    })
  })

/** Where the CLI is: its default install folder on Windows, else the `PATH`. */
export function tailscaleCli(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (platform === 'win32') {
    const path = join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')
    if (existsSync(path)) return path
  }
  return 'tailscale'
}

const SETUP = 'Install Tailscale on this computer and your phone, sign both in to the same tailnet, and turn on MagicDNS and HTTPS Certificates in its DNS settings.'

/** This machine's name on the tailnet and its Tailscale IPv4 address. */
export async function tailscaleStatus(cli = tailscaleCli(), exec: Run = run): Promise<TailscaleInfo> {
  let out: string
  try {
    out = await exec(cli, ['status', '--json'])
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new Error(code === 'ENOENT' ? `Tailscale isn't installed. ${SETUP}` : `Tailscale isn't running. ${SETUP}`, { cause: err })
  }
  const status = JSON.parse(out) as {
    BackendState?: string
    CertDomains?: string[] | null
    Self?: { HostName?: string; TailscaleIPs?: string[] }
  }
  if (status.BackendState !== 'Running') throw new Error(`Tailscale isn't connected (${status.BackendState ?? 'unknown state'}). Open Tailscale and sign in.`)
  const host = status.CertDomains?.[0]
  if (!host) throw new Error('This tailnet has no HTTPS certificates. Turn on MagicDNS and HTTPS Certificates in its DNS settings.')
  const ip = status.Self?.TailscaleIPs?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))
  if (!ip) throw new Error('Tailscale gave this computer no IPv4 address.')
  return { host, ip, machine: status.Self?.HostName ?? host.split('.')[0] }
}

/**
 * Gets the certificate for `host`, written to `dir`: Tailscale's cached one, or a new one once fewer than
 * 30 days are left (`--min-validity`; Let's Encrypt issues 90 days). A new one takes about 30 s.
 */
export async function tailscaleCert(host: string, dir: string, cli = tailscaleCli(), exec: Run = run): Promise<Certificate> {
  const certFile = join(dir, 'bridge-cert.pem')
  const keyFile = join(dir, 'bridge-key.pem')
  try {
    await exec(cli, ['cert', '--min-validity', '720h', '--cert-file', certFile, '--key-file', keyFile, host])
  } catch (err) {
    const detail = String((err as { stderr?: string }).stderr ?? '').trim().split('\n')[0]
    throw new Error(`Tailscale couldn't issue a certificate for ${host}${detail ? `: ${detail}` : '.'}`, { cause: err })
  }
  const [cert, key] = await Promise.all([readFile(certFile), readFile(keyFile)])
  return { cert, key, expiresAt: Date.parse(new X509Certificate(cert).validTo) }
}
