import { useState } from 'react'

import { Button } from '@/components/ui/button'

export default function App() {
  const [count, setCount] = useState(0)

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6">
      <p className="text-5xl font-medium tabular-nums tracking-tight">{count}</p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={() => setCount((n) => n - 1)}
        >
          Decrement
        </Button>
        <Button onClick={() => setCount((n) => n + 1)}>Increment</Button>
        <Button
          variant="ghost"
          disabled={count === 0}
          onClick={() => setCount(0)}
        >
          Reset
        </Button>
      </div>
    </main>
  )
}
