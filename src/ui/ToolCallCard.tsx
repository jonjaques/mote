import {
  Check,
  CircleAlert,
  FileCode2,
  LoaderCircle,
  ScanSearch,
  TerminalSquare,
} from 'lucide-react'

import type { AgentToolActivity } from '@/llm/agent'

function ToolIcon({ name }: { name: string }) {
  if (name === 'run_js') return <TerminalSquare />
  if (name === 'get_dom') return <ScanSearch />
  return <FileCode2 />
}

function argumentLabel(activity: AgentToolActivity): string {
  const path = activity.call.arguments.path
  if (typeof path === 'string') return path
  const code = activity.call.arguments.code
  if (typeof code === 'string') return code.slice(0, 46)
  return ''
}

export function ToolCallCard({ activity }: { activity: AgentToolActivity }) {
  const label = argumentLabel(activity)

  return (
    <div className={`tool-call tool-${activity.status}`}>
      <ToolIcon name={activity.call.name} />
      <div>
        <strong>{activity.call.name}</strong>
        {label && <code>{label}</code>}
        {activity.result && <small>{activity.result.summary}</small>}
      </div>
      {activity.status === 'running' ? (
        <LoaderCircle className="animate-spin" aria-label="Running" />
      ) : activity.status === 'complete' ? (
        <Check aria-label="Complete" />
      ) : (
        <CircleAlert aria-label="Failed" />
      )}
    </div>
  )
}
