import type { StoredSchedule, ScheduleRun } from "@getpaseo/protocol/schedule/types";

// COMPAT(automations): fork-only until upstream lands its own shape.
export function projectAutomation(
  schedule: StoredSchedule,
  capable: boolean,
): StoredSchedule | null {
  if (capable) return schedule;
  if (schedule.cadence.type === "none" || schedule.target.type === "action") return null;
  const { triggers: _triggers, source: _source, pauseReason: _reason, ...legacy } = schedule;
  return { ...legacy, runs: projectAutomationRuns(schedule.runs, false) };
}

export function projectAutomationRuns(runs: ScheduleRun[], capable: boolean): ScheduleRun[] {
  if (capable) return runs;
  return runs.map(({ trigger: _trigger, ...run }) => run);
}
