import {
  Check,
  CircleAlert,
  FileCode2,
  FileSearch,
  FolderTree,
  LoaderCircle,
  ScanSearch,
  TerminalSquare,
} from 'lucide-react'

import type { AgentToolActivity } from '@/llm/agent'
import { useAppState } from '@/state'

function ToolIcon({ name }: { name: string }) {
  if (name === 'run_js') return <TerminalSquare />
  if (name === 'get_dom') return <ScanSearch />
  if (name === 'read_file') return <FileSearch />
  if (name === 'list_files') return <FolderTree />
  return <FileCode2 />
}

const VERBS: Record<string, string> = {
  write_file: 'Write',
  read_file: 'Read',
  list_files: 'List files',
  run_js: 'Run JS',
  get_dom: 'Inspect DOM',
}

function formatBytes(value: number): string {
  return value < 1_024 ? `${value} B` : `${(value / 1_024).toFixed(1)} KB`
}

// What the tool actually did, in one line, without echoing a whole file into the chat.
function detailLine(activity: AgentToolActivity): string | undefined {
  const { call, result } = activity
  if (!result) return undefined
  if (!result.ok) return result.summary
  if (call.name === 'write_file') {
    const bytes = (result.value as { bytes?: number } | undefined)?.bytes
    return bytes === undefined ? result.summary : formatBytes(bytes)
  }
  if (call.name === 'list_files') {
    const files = result.value as Array<{ path: string; bytes: number }> | undefined
    return files ? files.map((file) => file.path).join(', ') : result.summary
  }
  if (call.name === 'run_js') {
    const value = result.value as { result?: unknown; error?: string } | undefined
    if (value?.error) return value.error
    return value?.result === undefined || value.result === 'undefined'
      ? 'no return value'
      : `→ ${String(value.result).slice(0, 120)}`
  }
  if (call.name === 'read_file') {
    const text = typeof result.value === 'string' ? result.value : ''
    return `${text.length.toLocaleString()} characters`
  }
  return undefined
}

export function ToolCallCard({ activity }: { activity: AgentToolActivity }) {
  const { dispatch } = useAppState()
  const { call, result, status } = activity
  const path = typeof call.arguments.path === 'string' ? call.arguments.path : undefined
  const code = typeof call.arguments.code === 'string' ? call.arguments.code : undefined
  const detail = detailLine(activity)
  const consoleLines = (result?.value as { console?: Array<{ level: string; text: string }> } | undefined)
    ?.console
  const canOpen = path !== undefined && status !== 'running' && call.name !== 'read_file'

  return (
    <div className={`tool-call tool-${status}`}>
      <ToolIcon name={call.name} />
      <div>
        <strong>
          {VERBS[call.name] ?? call.name}
          {path && (
            <>
              {' '}
              {canOpen ? (
                <button
                  type="button"
                  className="tool-path"
                  onClick={() => dispatch({ type: 'openFile', path })}
                  title="Open in Files"
                >
                  {path}
                </button>
              ) : (
                <code>{path}</code>
              )}
            </>
          )}
        </strong>
        {code && <pre className="tool-code">{code}</pre>}
        {detail && <small>{detail}</small>}
        {consoleLines && consoleLines.length > 0 && (
          <pre className="tool-code tool-console">
            {consoleLines.map((line) => `[${line.level}] ${line.text}`).join('\n')}
          </pre>
        )}
        {result?.runtimeErrors?.map((error) => (
          <small key={error} className="tool-runtime-error">
            {error}
          </small>
        ))}
      </div>
      {status === 'running' ? (
        <LoaderCircle className="animate-spin" aria-label="Running" />
      ) : status === 'complete' ? (
        <Check aria-label="Complete" />
      ) : (
        <CircleAlert aria-label="Failed" />
      )}
    </div>
  )
}
