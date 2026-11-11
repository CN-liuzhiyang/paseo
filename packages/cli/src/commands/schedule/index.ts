import { createSourceCommand } from "./source.js";
import { Command, Option } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runCreateCommand } from "./create.js";
import { runLsCommand } from "./ls.js";
import { runInspectCommand } from "./inspect.js";
import { runLogsCommand } from "./logs.js";
import { runPauseCommand } from "./pause.js";
import { runResumeCommand } from "./resume.js";
import { runDeleteCommand } from "./delete.js";
import { runRunOnceCommand } from "./run-once.js";
import { runUpdateCommand } from "./update.js";
import { runActionsCommand } from "./actions.js";
import { runTriggersCommand } from "./triggers.js";
import { runChannelsCommand } from "./channels.js";

export function createScheduleCommand(): Command {
  const schedule = new Command("schedule")
    .alias("automation")
    .description("Manage recurring schedules");

  schedule.addCommand(createSourceCommand());

  addJsonAndDaemonHostOptions(
    schedule
      .command("create")
      .description("Create a schedule")
      .option("--action <id>", "Plugin action to execute")
      .argument("<prompt>", "Prompt to run on the schedule")
      .option(
        "--on <source:event[,k=v...]>",
        "Event trigger (repeatable)",
        (value: string, previous: string[] = []) => [...previous, value],
      )
      .option(
        "--param <k=v>",
        "Action parameter (repeatable)",
        (value: string, previous: string[] = []) => [...previous, value],
      )
      .option("--params-json <json>", "Action parameters as a JSON object")
      .option("--timeout <duration>", "Action timeout (maximum 60m)")
      .option("--every <duration>", "Cron-compatible cadence preset (for example: 5m, 1h)")
      .option("--cron <expr>", "Cron cadence expression")
      .option("--timezone <iana>", "IANA time zone for cron cadence (default: UTC)")
      .option("--name <name>", "Optional schedule name")
      .addOption(new Option("--target <target>", "Legacy schedule target").hideHelp())
      .option(
        "--provider <provider>",
        "Agent provider, or provider/model (e.g. codex or codex/gpt-5.4)",
      )
      .option(
        "--mode <mode>",
        "Provider-specific mode (e.g. claude bypassPermissions, opencode build)",
      )
      .option("--thinking <id>", "Thinking option ID for new-agent runs")
      .option(
        "--cwd <path>",
        "Working directory (default: current; required with --host unless --workspace is set)",
      )
      .option(
        "--workspace <id>",
        "Run every execution in this existing workspace instead of creating one (its directory is used as cwd)",
      )
      .option("--run-now", "Fire one immediate run on creation")
      .option("--max-runs <n>", "Maximum number of runs")
      .option("--expires-in <duration>", "Time to live for the schedule")
      .option(
        "--deliver <channel:to>",
        "Send each run's result to a plugin channel (for example: chat:general)",
      ),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(schedule.command("ls").description("List schedules")).action(
    withOutput(runLsCommand),
  );

  addJsonAndDaemonHostOptions(
    schedule
      .command("channels")
      .description("List the delivery channels plugins offer, with their destinations"),
  ).action(withOutput(runChannelsCommand));

  addJsonAndDaemonHostOptions(
    schedule.command("inspect").description("Inspect a schedule").argument("<id>", "Schedule ID"),
  ).action(withOutput(runInspectCommand));

  addJsonAndDaemonHostOptions(
    schedule
      .command("logs")
      .description("Show recent schedule run logs")
      .argument("<id>", "Schedule ID"),
  ).action(withOutput(runLogsCommand));

  addJsonAndDaemonHostOptions(
    schedule.command("pause").description("Pause a schedule").argument("<id>", "Schedule ID"),
  ).action(withOutput(runPauseCommand));

  addJsonAndDaemonHostOptions(
    schedule
      .command("resume")
      .description("Resume a paused schedule")
      .argument("<id>", "Schedule ID"),
  ).action(withOutput(runResumeCommand));

  addJsonAndDaemonHostOptions(
    schedule.command("delete").description("Delete a schedule").argument("<id>", "Schedule ID"),
  ).action(withOutput(runDeleteCommand));

  addJsonAndDaemonHostOptions(
    schedule
      .command("run-once")
      .description("Manually trigger a single run of a schedule without affecting cadence")
      .option("--event-json <json>", "Test event (recorded as manual, bypasses deduplication)")
      .argument("<id>", "Schedule ID"),
  ).action(withOutput(runRunOnceCommand));

  addJsonAndDaemonHostOptions(
    schedule
      .command("update")
      .description("Update an existing schedule in place")
      .option("--clear-on", "Clear all event triggers")
      .option("--no-clock", "Remove the clock trigger")
      .option(
        "--on <source:event[,k=v...]>",
        "Replace event triggers (repeatable)",
        (value: string, previous: string[] = []) => [...previous, value],
      )
      .option(
        "--param <k=v>",
        "Replace action parameters (repeatable)",
        (value: string, previous: string[] = []) => [...previous, value],
      )
      .option("--params-json <json>", "Replace action parameters as a JSON object")
      .option("--timeout <duration>", "Action timeout (maximum 60m)")
      .argument("<id>", "Schedule ID")
      .option("--every <duration>", "Cron-compatible cadence preset (for example: 5m, 1h)")
      .option("--cron <expr>", "Switch to cron cadence expression")
      .option("--timezone <iana>", "IANA time zone for cron cadence (requires --cron)")
      .option("--name <name>", "Rename the schedule (empty string clears the name)")
      .option("--prompt <text>", "Replace the schedule prompt")
      .option(
        "--provider <provider>",
        "New agent provider, or provider/model (only for new-agent target)",
      )
      .option("--model <model>", "New agent model (only for new-agent target)")
      .option("--mode <mode>", "New agent provider mode (only for new-agent target)")
      .option("--cwd <path>", "New working directory (only for new-agent target)")
      .option("--workspace <id>", "Run every execution in this existing workspace")
      .option(
        "--no-workspace",
        "Create a new workspace for each run again (keeps the current working directory)",
      )
      .option("--max-runs <n>", "Set or change maximum number of runs")
      .option("--no-max-runs", "Clear the max-runs limit")
      .option("--expires-in <duration>", "Set or change time to live for the schedule")
      .option("--no-expires-in", "Clear the expiration")
      .option("--deliver <channel:to>", "Send each run's result to a plugin channel")
      .option("--no-deliver", "Stop delivering run results"),
  ).action(withOutput(runUpdateCommand));

  addJsonAndDaemonHostOptions(
    schedule.command("actions").description("List plugin actions and parameter schemas"),
  ).action(withOutput(runActionsCommand));
  addJsonAndDaemonHostOptions(
    schedule.command("triggers").description("List plugin event sources"),
  ).action(withOutput(runTriggersCommand));
  return schedule;
}
