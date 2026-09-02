import { useEffect, useState } from 'react'
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

  useEffect(() => sandboxBridge.subscribeConsole(setEntries), [])

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
      <div className="console-lines" aria-live="polite">
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
