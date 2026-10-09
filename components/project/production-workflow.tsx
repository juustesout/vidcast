import type { DerivedWorkflowStatus, WorkflowNavigationTarget, WorkflowStepId } from '@/lib/workflow/workflow-status';
import { describeRecommendedStep } from '@/lib/workflow/workflow-navigation';

interface ProductionWorkflowProps {
  workflow: DerivedWorkflowStatus;
  activeStepId: string | null;
  onNavigate: (target: WorkflowNavigationTarget, stepId?: WorkflowStepId) => void;
}

function statusClass(status: 'blocked' | 'needs_attention' | 'ready' | 'complete'): string {
  if (status === 'complete') return 'border-emerald-400/40 bg-emerald-300/10 text-emerald-100';
  if (status === 'ready') return 'border-sky-400/40 bg-sky-300/10 text-sky-100';
  if (status === 'needs_attention') return 'border-amber-300/40 bg-amber-200/10 text-amber-100';
  return 'border-rose-400/40 bg-rose-500/10 text-rose-100';
}

export function ProductionWorkflow({ workflow, activeStepId, onNavigate }: ProductionWorkflowProps) {
  const recommended = workflow.steps.find((step) => step.id === workflow.recommendedStepId) ?? workflow.steps[0];
  const recommendedPresentation = describeRecommendedStep(recommended);

  return (
    <section className="rounded-[24px] border border-slate-700/70 bg-slate-950/35 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Production workflow</p>
          <h2 className="mt-2 text-lg font-semibold text-white">Recommended now: {recommended.label}</h2>
          <p className="mt-1 text-sm text-slate-300">{recommendedPresentation.description}</p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate(recommended.navigationTarget, recommended.id)}
          className="rounded-2xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70"
          aria-label={`${recommendedPresentation.buttonLabel}: ${recommended.label}`}
        >
          {recommendedPresentation.buttonLabel}
        </button>
      </div>

      <div className="mt-4 grid grid-flow-col auto-cols-[minmax(220px,1fr)] gap-3 overflow-x-auto pb-2 sm:grid-flow-row sm:grid-cols-2 sm:overflow-visible xl:grid-cols-4">
        {workflow.steps.map((step) => {
          const isActive = step.id === activeStepId;
          const isRecommended = step.id === workflow.recommendedStepId;
          const summary = step.blockers[0] ?? step.warnings[0] ?? (step.complete ? 'Step complete.' : 'Step is actionable.');
          return (
            <button
              key={step.id}
              type="button"
              onClick={() => onNavigate(step.navigationTarget, step.id)}
              aria-current={isActive ? 'step' : undefined}
              className={`rounded-2xl border p-3 text-left transition hover:border-slate-500/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70 ${statusClass(step.status)} ${isActive ? 'ring-1 ring-white/60' : ''} ${isRecommended ? 'shadow-[0_0_0_1px_rgba(255,255,255,0.14)_inset]' : ''}`}
            >
              <p className="font-mono text-[10px] uppercase tracking-[0.24em]">{step.label}</p>
              <div className="mt-2 flex flex-wrap gap-1 text-[10px] uppercase tracking-[0.16em]">
                <span className="rounded-full border border-current/35 px-2 py-0.5">{step.status.replace('_', ' ')}</span>
                {isRecommended ? <span className="rounded-full border border-current/35 px-2 py-0.5">recommended</span> : null}
                {isActive ? <span className="rounded-full border border-current/35 px-2 py-0.5">active</span> : null}
                {step.complete ? <span className="rounded-full border border-current/35 px-2 py-0.5">complete</span> : null}
              </div>
              <p className="mt-2 text-xs leading-5">{summary}</p>
            </button>
          );
        })}
      </div>

      {workflow.advisories.length > 0 ? (
        <div className="mt-4 rounded-2xl border border-amber-300/30 bg-amber-200/10 p-3">
          <p className="text-xs uppercase tracking-[0.2em] text-amber-200">Advisories</p>
          <div className="mt-2 space-y-2 text-xs text-amber-100">
            {workflow.advisories.slice(0, 4).map((advisory) => (
              <p key={advisory.id}>{advisory.message}</p>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
