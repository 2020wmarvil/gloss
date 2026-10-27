import { createContext } from 'react'

/** Scrolls the surrounding log to the bottom and keeps it there: the composer calls it on send. */
export const LogToBottom = createContext<() => void>(() => {})
