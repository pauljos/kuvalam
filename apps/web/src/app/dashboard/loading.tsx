'use client'

// Dashboard route segment loading state (Next.js App Router convention).
// Shown automatically during page transitions and initial loads within /dashboard/*.

export default function DashboardLoading() {
  return (
    <div className="flex items-center justify-center min-h-[60vh] w-full">
      <div className="flex flex-col items-center gap-4">
        <div className="relative w-12 h-12">
          <div className="absolute inset-0 rounded-full border-4 border-muted-foreground/20" />
          <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-primary animate-spin" />
        </div>
        <p className="text-muted-foreground text-sm animate-pulse">Loading…</p>
      </div>
    </div>
  )
}
