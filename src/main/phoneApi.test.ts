import { describe, expect, it } from 'vitest'
import { IPC } from '../shared/ipc'
import { PHONE_CHANNELS, PhoneApi } from './phoneApi'

describe('PhoneApi', () => {
  it('runs a registered handler with the call\'s arguments', async () => {
    const api = new PhoneApi()
    api.add(IPC.cancel, (id) => `cancelled ${String(id)}`)
    await expect(api.call(IPC.cancel, ['s1'])).resolves.toBe('cancelled s1')
  })

  it('refuses channels outside the allowlist, registered or not', async () => {
    const api = new PhoneApi()
    expect(() => api.add(IPC.settingsUpdate, () => null)).toThrow()
    await expect(api.call(IPC.settingsUpdate, [{}])).rejects.toThrow('isn\'t available from a phone')
    await expect(api.call(IPC.sessionsList, [])).rejects.toThrow('isn\'t available from a phone')
  })

  it('keeps desktop-only calls off the allowlist', () => {
    for (const channel of [
      IPC.settingsGet, IPC.settingsUpdate, IPC.settingsOpenFile, IPC.settingsPreviewMcpImport,
      IPC.openFileLink, IPC.sessionsOpenFolder, IPC.sessionsOpenObsidian, IPC.sessionsOpenReviewFile,
      IPC.sessionsSaveMarkdown, IPC.sessionsCopyMarkdown, IPC.composerShell, IPC.composerEditDraft,
      IPC.composerContexts, IPC.composerAttach, IPC.captureStart, IPC.annotateOpen, IPC.authSignIn,
      IPC.projectsOpen, IPC.projectsDelete, IPC.projectsClone, IPC.projectsCreateAt, IPC.settingsPickFolder,
      IPC.agentsTestOpenCode, IPC.agentsTestProfile, IPC.windowsPopOut, IPC.setBadge, IPC.confirmClose
    ]) expect(PHONE_CHANNELS.has(channel), channel).toBe(false)
  })

  it("lets phones rename, restart, delete and export a session (the session row's menu)", () => {
    for (const channel of [IPC.sessionsRename, IPC.sessionsRestart, IPC.sessionsDelete, IPC.sessionsMarkdown]) {
      expect(PHONE_CHANNELS.has(channel), channel).toBe(true)
    }
  })

  it('lets phones clone and create projects, only in the projects folder', () => {
    for (const channel of [IPC.projectsGithubRepos, IPC.projectsCloneToProjectsFolder, IPC.projectsFolder, IPC.projectsCreate]) {
      expect(PHONE_CHANNELS.has(channel), channel).toBe(true)
    }
    // The desktop's clone asks for a folder; phones can't name one.
    expect(PHONE_CHANNELS.has(IPC.projectsClone)).toBe(false)
  })

  it('opens review sessions to phones, except opening their files on the desktop', () => {
    for (const channel of [
      IPC.sessionsCreateReview, IPC.sessionsRunReview, IPC.sessionsReviewDiff, IPC.sessionsReviewFile,
      IPC.sessionsReviewRefs, IPC.sessionsSetReviewRange, IPC.threadsResolve
    ]) expect(PHONE_CHANNELS.has(channel), channel).toBe(true)
  })
})
