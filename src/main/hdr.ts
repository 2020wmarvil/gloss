// HDR displays for capture (SPEC → Visual feedback). desktopCapturer copies an HDR display as
// 8-bit without tone mapping, so ordinary content comes out clipped and washed out. On Windows,
// koffi duplicates such a display through DXGI in scRGB half floats and maps the display's SDR
// white level (Settings → Display → HDR, "SDR content brightness") to white, as the Snipping
// Tool does. Anything else, or any failure, is left to desktopCapturer.
import type { CaptureRect } from '../shared/capture'

/** A display's picture as BGRA bytes (Electron's bitmap order on Windows), at its physical size. */
export type HdrFrame = { width: number; height: number; bgra: Buffer }

/** scRGB's 1.0 is 80 nits. */
const SCRGB_NITS = 80
const DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020 = 12
const DXGI_FORMAT_R16G16B16A16_FLOAT = 10
const DXGI_MODE_ROTATION_IDENTITY = 1
const D3D_DRIVER_TYPE_UNKNOWN = 0
const D3D11_SDK_VERSION = 7
const D3D11_USAGE_STAGING = 3
const D3D11_CPU_ACCESS_READ = 0x20000
const D3D11_MAP_READ = 1
const QDC_ONLY_ACTIVE_PATHS = 2
const DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME = 1
const DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL = 11
/** sizeof(DISPLAYCONFIG_PATH_INFO), and where its target's adapter id and id are. */
const PATH_SIZE = 72
const PATH_TARGET = 20
const MODE_SIZE = 64

// The vtable slots used, from the Windows SDK headers (10.0.26100).
const QUERY_INTERFACE = 0
const RELEASE = 2
const FACTORY1_ENUM_ADAPTERS1 = 12
const ADAPTER_ENUM_OUTPUTS = 7
const OUTPUT5_DUPLICATE_OUTPUT1 = 26
const OUTPUT6_GET_DESC1 = 27
const DUPLICATION_ACQUIRE_NEXT_FRAME = 8
const DUPLICATION_RELEASE_FRAME = 14
const DEVICE_CREATE_TEXTURE2D = 5
const TEXTURE2D_GET_DESC = 10
const CONTEXT_MAP = 14
const CONTEXT_UNMAP = 15
const CONTEXT_COPY_RESOURCE = 47

type Ptr = unknown
type Koffi = typeof import('koffi')
type Api = {
  koffi: Koffi
  protos: Record<'qi' | 'release' | 'enumAt' | 'withBuffer' | 'duplicate' | 'acquire' | 'releaseFrame' | 'createTexture' | 'textureDesc' | 'copy' | 'map' | 'unmap', unknown>
  createFactory(iid: Buffer, out: Ptr[]): number
  createDevice(adapter: Ptr, type: number, software: null, flags: number, levels: null, count: number, sdk: number, device: Ptr[], level: null, context: Ptr[]): number
  bufferSizes(flags: number, paths: number[], modes: number[]): number
  queryConfig(flags: number, paths: number[], pathInfo: Buffer, modes: number[], modeInfo: Buffer, topology: null): number
  deviceInfo(packet: Buffer): number
  copyMemory(to: Buffer, from: Ptr, size: number): void
}

let api: Api | null | undefined

async function load(): Promise<Api | null> {
  if (api !== undefined) return api
  try {
    const koffi = await import('koffi')
    const user32 = koffi.load('user32.dll')
    const proto = (sig: string): unknown => koffi.proto(sig)
    api = {
      koffi,
      protos: {
        qi: proto('int32_t __stdcall GlossQueryInterface(void *self, void *iid, _Out_ void **out)'),
        release: proto('uint32_t __stdcall GlossRelease(void *self)'),
        enumAt: proto('int32_t __stdcall GlossEnumAt(void *self, uint32_t index, _Out_ void **out)'),
        withBuffer: proto('int32_t __stdcall GlossWithBuffer(void *self, void *buffer)'),
        duplicate: proto('int32_t __stdcall GlossDuplicateOutput1(void *self, void *device, uint32_t flags, uint32_t count, void *formats, _Out_ void **out)'),
        acquire: proto('int32_t __stdcall GlossAcquireNextFrame(void *self, uint32_t timeout, void *info, _Out_ void **resource)'),
        releaseFrame: proto('int32_t __stdcall GlossReleaseFrame(void *self)'),
        createTexture: proto('int32_t __stdcall GlossCreateTexture2D(void *self, void *desc, void *initial, _Out_ void **out)'),
        textureDesc: proto('void __stdcall GlossTextureDesc(void *self, void *desc)'),
        copy: proto('void __stdcall GlossCopyResource(void *self, void *to, void *from)'),
        map: proto('int32_t __stdcall GlossMap(void *self, void *resource, uint32_t sub, uint32_t type, uint32_t flags, void *mapped)'),
        unmap: proto('void __stdcall GlossUnmap(void *self, void *resource, uint32_t sub)')
      },
      createFactory: koffi.load('dxgi.dll').func('int32_t __stdcall CreateDXGIFactory1(void *riid, _Out_ void **factory)'),
      createDevice: koffi
        .load('d3d11.dll')
        .func(
          'int32_t __stdcall D3D11CreateDevice(void *adapter, int type, void *software, uint32_t flags, void *levels, uint32_t count, uint32_t sdk, _Out_ void **device, void *level, _Out_ void **context)'
        ),
      bufferSizes: user32.func('long __stdcall GetDisplayConfigBufferSizes(uint32_t flags, _Out_ uint32_t *paths, _Out_ uint32_t *modes)'),
      queryConfig: user32.func('long __stdcall QueryDisplayConfig(uint32_t flags, _Inout_ uint32_t *paths, void *pathInfo, _Inout_ uint32_t *modes, void *modeInfo, void *topology)'),
      deviceInfo: user32.func('long __stdcall DisplayConfigGetDeviceInfo(void *packet)'),
      // Electron won't wrap native memory in an ArrayBuffer (koffi.view), so the frame is copied out.
      copyMemory: koffi.load('kernel32.dll').func('void __stdcall RtlMoveMemory(void *to, void *from, size_t size)')
    } as Api
  } catch {
    api = null
  }
  return api
}

function guid(text: string): Buffer {
  const hex = text.replace(/-/g, '')
  const b = Buffer.alloc(16)
  b.writeUInt32LE(parseInt(hex.slice(0, 8), 16), 0)
  b.writeUInt16LE(parseInt(hex.slice(8, 12), 16), 4)
  b.writeUInt16LE(parseInt(hex.slice(12, 16), 16), 6)
  Buffer.from(hex.slice(16), 'hex').copy(b, 8)
  return b
}

const IID_IDXGIFactory1 = guid('770aae78-f26f-4dba-a829-253c83d1b387')
const IID_IDXGIOutput6 = guid('068346e8-aaec-4b84-add7-137f513f77a1')
const IID_ID3D11Texture2D = guid('6f15aaf2-d208-4e89-9ab4-489535d34f9c')

/** Calls a COM method by its vtable slot. */
function method(a: Api, self: Ptr, slot: number, proto: unknown, ...args: unknown[]): number {
  const vtable = a.koffi.decode(self, 'void *')
  const fn = a.koffi.decode(vtable, slot * 8, 'void *')
  return a.koffi.call(fn, proto as never, self, ...args) as number
}

function check(hr: number, what: string): void {
  if (hr < 0) throw new Error(`${what} failed (0x${(hr >>> 0).toString(16)}).`)
}

/** Each display's SDR white level in nits, by its GDI name (\\.\DISPLAY1). */
function sdrWhiteLevels(a: Api): Map<string, number> {
  const levels = new Map<string, number>()
  const np = [0]
  const nm = [0]
  if (a.bufferSizes(QDC_ONLY_ACTIVE_PATHS, np, nm) !== 0) return levels
  const paths = Buffer.alloc(np[0] * PATH_SIZE)
  const modes = Buffer.alloc(nm[0] * MODE_SIZE)
  if (a.queryConfig(QDC_ONLY_ACTIVE_PATHS, np, paths, nm, modes, null) !== 0) return levels
  for (let i = 0; i < np[0]; i++) {
    const at = i * PATH_SIZE
    // DISPLAYCONFIG_SOURCE_DEVICE_NAME: a header (type, size, adapter id, id), then the name.
    const source = Buffer.alloc(84)
    source.writeUInt32LE(DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, 0)
    source.writeUInt32LE(source.length, 4)
    paths.copy(source, 8, at, at + 12)
    if (a.deviceInfo(source) !== 0) continue
    // DISPLAYCONFIG_SDR_WHITE_LEVEL: the header, then the level in thousandths of 80 nits.
    const white = Buffer.alloc(24)
    white.writeUInt32LE(DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL, 0)
    white.writeUInt32LE(white.length, 4)
    paths.copy(white, 8, at + PATH_TARGET, at + PATH_TARGET + 12)
    if (a.deviceInfo(white) !== 0) continue
    levels.set(utf16z(source, 20, 84), (white.readUInt32LE(20) / 1000) * SCRGB_NITS)
  }
  return levels
}

function utf16z(b: Buffer, start: number, end: number): string {
  const s = b.toString('utf16le', start, end)
  const nul = s.indexOf('\0')
  return nul < 0 ? s : s.slice(0, nul)
}

/**
 * The pictures of the displays (by their physical rectangles) that are in HDR, tone mapped to
 * SDR; null for the others, and for any that fail. All null off Windows.
 */
export async function captureHdr(displays: CaptureRect[], platform = process.platform): Promise<(HdrFrame | null)[]> {
  const frames: (HdrFrame | null)[] = displays.map(() => null)
  if (platform !== 'win32') return frames
  const a = await load()
  if (!a) return frames
  const held: Ptr[] = []
  const keep = (p: Ptr): Ptr => (held.push(p), p)
  try {
    const factory = [null as Ptr]
    check(a.createFactory(IID_IDXGIFactory1, factory), 'CreateDXGIFactory1')
    keep(factory[0])
    let whites: Map<string, number> | null = null
    for (let i = 0; ; i++) {
      const adapter = [null as Ptr]
      if (method(a, factory[0], FACTORY1_ENUM_ADAPTERS1, a.protos.enumAt, i, adapter) < 0) break
      keep(adapter[0])
      for (let j = 0; ; j++) {
        const output = [null as Ptr]
        if (method(a, adapter[0], ADAPTER_ENUM_OUTPUTS, a.protos.enumAt, j, output) < 0) break
        keep(output[0])
        const output6 = [null as Ptr]
        if (method(a, output[0], QUERY_INTERFACE, a.protos.qi, IID_IDXGIOutput6, output6) < 0) continue
        keep(output6[0])
        // DXGI_OUTPUT_DESC1: name, desktop rectangle, attached, rotation, monitor, bits, color space…
        const desc = Buffer.alloc(152)
        if (method(a, output6[0], OUTPUT6_GET_DESC1, a.protos.withBuffer, desc) < 0) continue
        if (desc.readUInt32LE(100) !== DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020) continue
        // A rotated display's frame comes unrotated; desktopCapturer can have it.
        if (desc.readUInt32LE(84) !== DXGI_MODE_ROTATION_IDENTITY) continue
        const left = desc.readInt32LE(64)
        const top = desc.readInt32LE(68)
        const index = displays.findIndex((d) => d.x === left && d.y === top && d.width === desc.readInt32LE(72) - left && d.height === desc.readInt32LE(76) - top)
        if (index < 0) continue
        whites ??= sdrWhiteLevels(a)
        try {
          frames[index] = duplicate(a, adapter[0], output6[0], whites.get(utf16z(desc, 0, 64)) ?? SCRGB_NITS, displays[index])
        } catch {
          // desktopCapturer takes this one.
        }
      }
    }
  } catch {
    // desktopCapturer takes them all.
  } finally {
    for (const p of held.reverse()) method(a, p, RELEASE, a.protos.release)
  }
  return frames
}

/** One output's current frame, through a device of its own adapter. */
function duplicate(a: Api, adapter: Ptr, output: Ptr, whiteNits: number, size: CaptureRect): HdrFrame | null {
  const held: Ptr[] = []
  const keep = (p: Ptr): Ptr => (held.push(p), p)
  let acquired: Ptr = null
  try {
    const device = [null as Ptr]
    const context = [null as Ptr]
    check(a.createDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, null, 0, null, 0, D3D11_SDK_VERSION, device, null, context), 'D3D11CreateDevice')
    keep(device[0])
    keep(context[0])
    const formats = Buffer.alloc(4)
    formats.writeUInt32LE(DXGI_FORMAT_R16G16B16A16_FLOAT)
    const duplication = [null as Ptr]
    check(method(a, output, OUTPUT5_DUPLICATE_OUTPUT1, a.protos.duplicate, device[0], 0, 1, formats, duplication), 'DuplicateOutput1')
    keep(duplication[0])
    // The first frame is the whole desktop as it is.
    const info = Buffer.alloc(48)
    const resource = [null as Ptr]
    check(method(a, duplication[0], DUPLICATION_ACQUIRE_NEXT_FRAME, a.protos.acquire, 500, info, resource), 'AcquireNextFrame')
    acquired = duplication[0]
    keep(resource[0])
    const texture = [null as Ptr]
    check(method(a, resource[0], QUERY_INTERFACE, a.protos.qi, IID_ID3D11Texture2D, texture), 'QueryInterface')
    keep(texture[0])
    // D3D11_TEXTURE2D_DESC, turned into a CPU-readable copy of the frame.
    const desc = Buffer.alloc(44)
    method(a, texture[0], TEXTURE2D_GET_DESC, a.protos.textureDesc, desc)
    const width = desc.readUInt32LE(0)
    const height = desc.readUInt32LE(4)
    if (width !== size.width || height !== size.height || desc.readUInt32LE(16) !== DXGI_FORMAT_R16G16B16A16_FLOAT) return null
    for (const [offset, value] of [[8, 1], [12, 1], [20, 1], [24, 0], [28, D3D11_USAGE_STAGING], [32, 0], [36, D3D11_CPU_ACCESS_READ], [40, 0]]) desc.writeUInt32LE(value, offset)
    const staging = [null as Ptr]
    check(method(a, device[0], DEVICE_CREATE_TEXTURE2D, a.protos.createTexture, desc, null, staging), 'CreateTexture2D')
    keep(staging[0])
    method(a, context[0], CONTEXT_COPY_RESOURCE, a.protos.copy, staging[0], texture[0])
    // D3D11_MAPPED_SUBRESOURCE: the data and its row pitch.
    const mapped = Buffer.alloc(16)
    check(method(a, context[0], CONTEXT_MAP, a.protos.map, staging[0], 0, D3D11_MAP_READ, 0, mapped), 'Map')
    const pitch = mapped.readUInt32LE(8)
    const raw = Buffer.alloc(pitch * height)
    try {
      a.copyMemory(raw, mapped.readBigUInt64LE(0), raw.length)
    } finally {
      method(a, context[0], CONTEXT_UNMAP, a.protos.unmap, staging[0], 0)
    }
    return { width, height, bgra: scrgbToSdr(new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2), pitch / 2, width, height, whiteNits) }
  } finally {
    if (acquired) method(a, acquired, DUPLICATION_RELEASE_FRAME, a.protos.releaseFrame)
    for (const p of held.reverse()) method(a, p, RELEASE, a.protos.release)
  }
}

/**
 * scRGB (linear, BT.709, half floats in RGBA, `stride` halves a row) to 8-bit sRGB BGRA, with
 * `whiteNits` as white: SDR content comes out as it was drawn, brighter HDR content clips.
 */
export function scrgbToSdr(halves: Uint16Array, stride: number, width: number, height: number, whiteNits: number): Buffer {
  const scale = SCRGB_NITS / whiteNits
  const linear = new Float32Array(65536)
  for (let h = 0; h < 0x8000; h++) {
    const exp = (h >> 10) & 31
    const mantissa = h & 1023
    // Negative values (outside BT.709) clip to 0, as do infinities and NaNs.
    linear[h] = exp === 31 ? 0 : (exp === 0 ? mantissa * 2 ** -24 : (1 + mantissa / 1024) * 2 ** (exp - 15)) * scale
  }
  const steps = 4096
  const encode = new Uint8Array(steps + 1)
  for (let i = 0; i <= steps; i++) {
    const l = i / steps
    encode[i] = Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055))
  }
  const toByte = (v: number): number => encode[v >= 1 ? steps : (v * steps + 0.5) | 0]
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0, i = y * stride, j = y * width * 4; x < width; x++, i += 4, j += 4) {
      out[j] = toByte(linear[halves[i + 2]])
      out[j + 1] = toByte(linear[halves[i + 1]])
      out[j + 2] = toByte(linear[halves[i]])
      out[j + 3] = 255
    }
  }
  return out
}
