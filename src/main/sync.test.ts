import { describe, expect, it } from 'vitest'
import { rangeNote } from '../shared/review'
import type { Thread } from '../shared/types'
import { MAIN_TAG, threadTag } from '../shared/wire'
import { placeUserMessage } from './sync'

describe('placeUserMessage', () => {
  const thread: Thread = { id: 't', sessionId: 's', anchorMessageId: 'm', anchor: { kind: 'selection', start: 0, end: 3, text: 'abc' }, createdAt: 1 }
  const note = rangeNote({ base: 'abc', headRef: null, head: 'def' })

  it('leaves out a review range note, which is for the agent', () => {
    expect(placeUserMessage(`${note}\nLook again`, [], new Map())).toEqual({ threadId: null, text: 'Look again' })
    expect(placeUserMessage(`${note}\n${threadTag(thread.anchor)}\nWhy?`, [thread], new Map())).toEqual({ threadId: 't', text: 'Why?' })
    expect(placeUserMessage(`${note}\n${MAIN_TAG}\nok`, [thread], new Map())).toEqual({ threadId: null, text: 'ok' })
  })
})
