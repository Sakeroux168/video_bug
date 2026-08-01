import React from 'react'

export function Tabs({ tabs, active, onChange }: { tabs: Array<{ key: string; label: string }>; active: string; onChange: (k: string) => void }) {
  return (
    <div className="flex gap-1 border-b border-zinc-200 bg-white px-4">
      {tabs.map(t => (
        <button key={t.key} onClick={() => onChange(t.key)}
          className={`px-4 py-3 text-sm font-medium transition-colors ${active === t.key ? 'border-b-2 border-blue-600 text-blue-600' : 'text-zinc-500 hover:text-zinc-800'}`}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      {title && <h3 className="mb-3 text-sm font-semibold text-zinc-700">{title}</h3>}
      {children}
    </div>
  )
}

export const inputCls = 'rounded-md border border-zinc-300 px-3 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
export const btnPrimary = 'rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40'
