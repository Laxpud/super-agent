import type { StudioProjectRun, StudioProjectWorkView } from './project-store.js'

type DispatchDiagnosis = { reason: string; nextCheck: string }

// Project text work saves the two quota denials from the runner's provider check, not raw adapter errors.
const quotaDenial = /^Studio quota pool ([a-z][a-z0-9_-]{0,47}): (waiting for recovery confirmation|stop state could not be confirmed)\. See \/studio-quota\.$/
const unconfirmed: DispatchDiagnosis = {
  reason: 'No complete Worker result was saved. The reason could not be confirmed.',
  nextCheck: 'Review the registered inputs and, if available, the Worker Session for this attempt.',
}

/** Translate only known saved reasons; the absence of complete text does not identify a cause. */
function savedReason({ failure, state }: StudioProjectRun, job: StudioProjectWorkView['job']): DispatchDiagnosis {
  switch (failure) {
    case 'TEXT_WORKER_MODEL_UNCONFIRMED':
      return {
        reason: 'Studio could not confirm the pinned or configured Worker model route for this attempt.',
        nextCheck: 'Check the eligible provider, model and reasoning effort against the adapter and any saved model selection.',
      }
    case 'WORKER_TIMEOUT':
      return {
        reason: 'The Worker time limit expired before Studio saved a complete result.',
        nextCheck: 'Review the scope of the registered request and, if available, the Worker Session for this attempt.',
      }
    case 'STALE_MANAGEMENT':
      return {
        reason: 'The dispatch no longer matched the project’s current Leader and management epoch.',
        nextCheck: 'Check the current Leader Session and management epoch with /studio-project status.',
      }
    case 'LEADER_UNAVAILABLE':
      return {
        reason: 'The Leader Session was not available for this dispatch.',
        nextCheck: 'Check the current Leader with /studio-project status and whether that Session is available.',
      }
    case 'WORK_MODEL_SELECTION_NOT_CURRENT':
      return {
        reason: 'The saved model selection could not be confirmed for this dispatch.',
        nextCheck: 'Check the model selection status in this work detail and which execution epoch used it, if shown.',
      }
    case 'FACT_NOT_CURRENT':
    case 'FACT_PROJECT_MISMATCH':
      return {
        reason: 'Studio could not confirm the exact pinned project fact for this dispatch.',
        nextCheck: 'Check the fact key and revision against the project archive and the original evidence.',
      }
    case 'RESULT_SOURCE_NOT_CURRENT':
      return {
        reason: 'Studio could not confirm the exact source of the pinned Worker result excerpt.',
        nextCheck: 'Check the source work and its saved Worker result at the coordinates in this work detail.',
      }
    case 'HOST_RESTARTED':
      return state === 'released' || state === 'interrupted' ? {
        reason: 'Studio recorded this outcome during Host restart recovery.',
        nextCheck: 'Check current project management and any saved model selection; the restart did not authorize work.',
      } : unconfirmed
    case 'PROJECT_WORK_BLOCKED':
      return state === 'released' ? {
        reason: 'The owner blocked this work before the reservation reached Studio start.',
        nextCheck: 'Review the saved obstacle and whether the work is still blocked in this work detail.',
      } : unconfirmed
    case 'EXTERNAL_JOB_PAUSED':
    case 'EXTERNAL_JOB_NOT_COMPLETE':
      return job ? {
        reason: failure === 'EXTERNAL_JOB_PAUSED'
          ? 'Post-processing for the linked external job was paused for this attempt.'
          : 'The linked external job did not have a saved successful completion for this attempt.',
        nextCheck: `Check the saved job and post-processing status with /studio-job status ${job.workId}.`,
      } : unconfirmed
    case 'NO_COMPLETE_WORKER_TEXT':
    case undefined:
      return unconfirmed
    default: {
      const quota = quotaDenial.exec(failure)
      if (!quota) return unconfirmed
      const [, pool, status] = quota
      return {
        reason: status === 'waiting for recovery confirmation'
          ? `Quota pool ${pool} was stopped pending recovery confirmation at the time.`
          : `Studio could not confirm the stop state of quota pool ${pool} at the time.`,
        nextCheck: 'Check the current quota pool status with /studio-quota status.',
      }
    }
  }
}

/** Describe the latest saved text dispatch for the current Leader’s native work detail, without checking live state. */
export function projectDispatchDiagnosis(view: StudioProjectWorkView): string {
  const { run, document, job, modelSelection } = view
  if (!run || document || (run.state !== 'released' && run.state !== 'failed' && run.state !== 'interrupted')) return ''

  // A saved start is a Studio state transition, not proof the model adapter was entered.
  const lifecycle = run.state === 'released'
    ? 'The reservation never reached Studio start. This record is not authorization to start work.'
    : 'This work ID cannot be started again. Studio start does not establish that the Worker reached the model adapter.'
  const { reason, nextCheck } = savedReason(run, job)
  // A cleared selection can still carry its original spend; never attribute a different epoch's spend to this run.
  const spent = run.state === 'released' && modelSelection?.executionEpoch === run.executionEpoch
    ? ' The one-time model selection used on this execution was not restored automatically. Check the model selection status in this work detail.' : ''
  return `Saved dispatch diagnosis\nExecution epoch ${run.executionEpoch}: ${run.state}. ${lifecycle}\n${reason}\nSuggested read-only check: ${nextCheck}${spent}`
}
