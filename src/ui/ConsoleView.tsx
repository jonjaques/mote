import { useEffect, useRef, useState } from 'react'
import { Ban, CircleAlert, Info, TerminalSquare, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  sandboxBridge,
  type ConsoleLevel,
  type SandboxConsoleEntry,
} from '@/sandbox/runtime'

function LevelIcon({ level }: { level: ConsoleLevel }) {
  if (level === 'error') return <CircleAlert />
  if (level === 'warn') return <TriangleAlert />
  if (level === 'info') return <Info />
  return <TerminalSquare />
}

export function ConsoleView() {
  const [entries, setEntries] = useState<SandboxConsoleEntry[]>(
    sandboxBridge.getConsoleEntries(),
  )
  const linesRef = useRef<HTMLDivElement>(null)
  // Whether the reader is parked at the bottom. Tracked on scroll rather than measured in the
  // effect below, because by the time the effect runs the new lines are already in the box and
  // "were we at the bottom?" can no longer be answered.
  const followRef = useRef(true)

  useEffect(() => sandboxBridge.subscribeConsole(setEntries), [])

  // Follow new output the way a terminal does. A 60-line burst from `run_js` used to leave the
  // console showing line 0, with the error that caused it far below the fold. Only follows
  // while the reader is already at the bottom: yanking someone out of scrollback to show them
  // the newest line is worse than not following at all.
  useEffect(() => {
    const box = linesRef.current
    if (box && followRef.current) box.scrollTop = box.scrollHeight
  }, [entries])

  return (
    <div className="console-view">
      <header>
        <span>Runtime output</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => sandboxBridge.clearConsole()}
          disabled={!entries.length}
        >
          <Ban />
          Clear
        </Button>
      </header>
      {/* `role="log"` rather than a bare live region: it carries the same polite announcement
          but tells assistive tech this is an append-ordered log, which is what it is. */}
      <div
        ref={linesRef}
        className="console-lines"
        role="log"
        onScroll={(event) => {
          const box = event.currentTarget
          followRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24
        }}
      >
        {entries.length === 0 ? (
          <p className="console-empty">No console output from the current document.</p>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className={`console-line console-${entry.level}`}>
              <LevelIcon level={entry.level} />
              <time dateTime={new Date(entry.timestamp).toISOString()}>
                {new Date(entry.timestamp).toLocaleTimeString([], {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </time>
              <code>{entry.args.join(' ')}</code>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
