import { useCallback, useMemo, type Dispatch, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { Plus, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { ScheduleAction, ScheduleTriggerSource } from "@getpaseo/protocol/schedule/types";
import { Button } from "@/components/ui/button";
import type { ControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import {
  AGENT_RUN,
  objectFields,
  type AutomationFormAction,
  type AutomationFormState,
  type ClockKind,
  type EventTriggerDraft,
  type ParamField,
} from "@/schedules/automation-form";

/** What the form sheet hands both field groups. */
export interface AutomationFieldsProps {
  state: AutomationFormState;
  dispatch: Dispatch<AutomationFormAction>;
  actions: ScheduleAction[];
  sources: ScheduleTriggerSource[];
  locked: boolean;
  issues: Record<string, string> | null;
}

interface CommonProps {
  state: AutomationFormState;
  dispatch: Dispatch<AutomationFormAction>;
  size: ControlSize;
}

// "Cron" is the same word in every language.
const CLOCK_LABEL_KEYS = { every: "automation.clockEvery", none: "automation.clockNone" } as const;

/** What each run does: an AI session, or a plugin action with a form built from its schema. */
export function AutomationRunFields({
  state,
  dispatch,
  size,
  actions,
  locked,
  issues,
}: CommonProps & {
  actions: ScheduleAction[];
  /** The daemon cannot switch an existing automation between a session and an action. */
  locked: boolean;
  issues: Record<string, string> | null;
}): ReactElement {
  const { t } = useTranslation();
  const options = useMemo<SelectFieldOption<string>[]>(
    () => [
      {
        id: AGENT_RUN,
        value: AGENT_RUN,
        label: t("automation.runAgent"),
        testID: "automation-run-agent",
      },
      ...actions.map((action) => ({
        id: action.id,
        value: action.id,
        label: action.label ?? action.id,
        description: action.description ?? action.pluginId,
        testID: `automation-run-${action.id}`,
      })),
    ],
    [actions, t],
  );
  const selectedDisplay = useMemo(
    () => ({ label: options.find((option) => option.value === state.run)?.label ?? state.run }),
    [options, state.run],
  );
  const handleRun = useCallback((run: string) => dispatch({ type: "run", run }), [dispatch]);
  const selected = actions.find((action) => action.id === state.run);
  const fields = selected ? objectFields(selected.params) : null;
  return (
    <>
      <SelectField
        label={t("automation.run")}
        value={state.run}
        selectedDisplay={selectedDisplay}
        options={options}
        onChange={handleRun}
        disabled={locked}
        searchable={options.length > 8}
        title={t("automation.run")}
        placeholder={t("automation.run")}
        emptyText={t("common.empty.noResults")}
        size={size}
        triggerTestID="automation-run-trigger"
      />
      {state.run === AGENT_RUN ? null : (
        <Field label={t("automation.params")} error={issues?.[""]} testID="automation-params">
          <View style={styles.stack}>
            {fields ? (
              fields.map((field) => (
                <ParamFieldRow
                  key={field.key}
                  field={field}
                  path={field.key}
                  state={state}
                  dispatch={dispatch}
                  size={size}
                  issues={issues}
                />
              ))
            ) : (
              <JsonInput path="" state={state} dispatch={dispatch} size={size} />
            )}
          </View>
        </Field>
      )}
    </>
  );
}

function readPath(params: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((current, part) => (current as Record<string, unknown>)?.[part], params);
}

const splitList = (text: string) =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  return value === undefined ? "" : String(value);
}

function ParamFieldRow({
  field,
  path,
  state,
  dispatch,
  size,
  issues,
}: CommonProps & {
  field: ParamField;
  path: string;
  issues: Record<string, string> | null;
}): ReactElement {
  const { t } = useTranslation();
  const rest = { state, dispatch, size, issues };
  const value = readPath(state.params, path);
  const set = useCallback(
    (next: unknown) => dispatch({ type: "param", path: path.split("."), value: next }),
    [dispatch, path],
  );
  const handleText = useCallback(
    (text: string) => {
      if (field.kind === "number") set(text.trim() === "" ? undefined : Number(text));
      else if (field.kind === "strings") set(splitList(text));
      else set(text === "" && !field.required ? undefined : text);
    },
    [field, set],
  );
  const enumDisplay = useMemo(() => (typeof value === "string" ? { label: value } : null), [value]);
  if (field.kind === "object") {
    return (
      <Field label={field.label}>
        <View style={styles.nested}>
          {field.fields?.map((child) => (
            <ParamFieldRow key={child.key} field={child} path={`${path}.${child.key}`} {...rest} />
          ))}
        </View>
      </Field>
    );
  }
  let control: ReactNode;
  if (field.kind === "boolean")
    control = (
      <Switch value={value === true} onValueChange={set} accessibilityLabel={field.label} />
    );
  else if (field.kind === "enum")
    control = (
      <SelectField
        label={field.label}
        value={typeof value === "string" ? value : null}
        selectedDisplay={enumDisplay}
        options={field.options ?? []}
        onChange={set}
        searchable={false}
        title={field.label}
        placeholder={field.label}
        emptyText={t("common.empty.noResults")}
        size={size}
        field={false}
      />
    );
  else if (field.kind === "json")
    control = <JsonInput path={path} state={state} dispatch={dispatch} size={size} />;
  else
    control = (
      <FormTextInput
        size={size}
        accessibilityLabel={field.label}
        testID={`automation-param-${path}`}
        initialValue={displayValue(value)}
        keyboardType={field.kind === "number" ? "numeric" : "default"}
        autoCapitalize="none"
        onChangeText={handleText}
      />
    );
  return (
    <Field label={field.required ? `${field.label} *` : field.label} error={issues?.[path]}>
      {control}
    </Field>
  );
}

function JsonInput({ path, state, dispatch, size }: CommonProps & { path: string }): ReactElement {
  const { t } = useTranslation();
  const value = path ? readPath(state.params, path) : state.params;
  const initial =
    state.jsonText[path] ?? (value === undefined ? "" : JSON.stringify(value, null, 2));
  const handleText = useCallback(
    (text: string) => dispatch({ type: "json", path, text }),
    [dispatch, path],
  );
  return (
    <View style={styles.stack}>
      <FormTextInput
        size={size}
        accessibilityLabel={path || t("automation.params")}
        testID={`automation-json-${path || "params"}`}
        initialValue={initial}
        onChangeText={handleText}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.json}
      />
      <Text style={styles.hint}>{t("automation.paramsJson")}</Text>
    </View>
  );
}

interface EventOption extends SelectFieldOption<string> {
  fields: string[];
}

/** Clock kind, event triggers and the event rate limit. The cron editor is the child. */
export function AutomationTriggerFields({
  state,
  dispatch,
  size,
  sources,
  children,
}: CommonProps & { sources: ScheduleTriggerSource[]; children: ReactNode }): ReactElement {
  const { t } = useTranslation();
  const clockOptions = useMemo(
    () =>
      (["cron", "every", "none"] as const).map((value) => ({
        value,
        label: value === "cron" ? "Cron" : t(CLOCK_LABEL_KEYS[value]),
        testID: `automation-clock-${value}`,
      })),
    [t],
  );
  const eventOptions = useMemo<EventOption[]>(
    () =>
      sources.flatMap((source) =>
        source.events.map((event) => ({
          id: `${source.id}:${event.id}`,
          value: `${source.id}:${event.id}`,
          label: `${source.label ?? source.id} · ${event.label ?? event.id}`,
          description: event.description,
          fields: event.fields ?? [],
          testID: `automation-event-${source.id}-${event.id}`,
        })),
      ),
    [sources],
  );
  const handleClock = useCallback(
    (clock: ClockKind) => dispatch({ type: "clock", clock }),
    [dispatch],
  );
  const handleEvery = useCallback((text: string) => dispatch({ type: "every", text }), [dispatch]);
  const handleRate = useCallback(
    (text: string) => dispatch({ type: "rateLimit", text }),
    [dispatch],
  );
  const handleAdd = useCallback(() => dispatch({ type: "addTrigger" }), [dispatch]);
  return (
    <>
      <Field label={t("automation.clock")}>
        <SegmentedControl<ClockKind>
          options={clockOptions}
          value={state.clock}
          onValueChange={handleClock}
          size={size}
          testID="automation-clock"
        />
      </Field>
      {state.clock === "cron" ? children : null}
      {state.clock === "every" ? (
        <Field label={t("automation.everyMinutes")}>
          <FormTextInput
            size={size}
            accessibilityLabel={t("automation.everyMinutes")}
            initialValue={state.everyMinutes}
            onChangeText={handleEvery}
            keyboardType="number-pad"
          />
        </Field>
      ) : null}
      <Field label={t("automation.triggers")}>
        <View style={styles.stack}>
          {state.triggers.map((trigger, index) => (
            <TriggerRow
              key={trigger.key}
              index={index}
              trigger={trigger}
              options={eventOptions}
              dispatch={dispatch}
              size={size}
            />
          ))}
          <Button
            variant="outline"
            size={size}
            leftIcon={Plus}
            onPress={handleAdd}
            testID="automation-trigger-add"
          >
            {t("automation.addTrigger")}
          </Button>
        </View>
      </Field>
      {state.triggers.length > 0 ? (
        <Field label={t("automation.rateLimit")}>
          <FormTextInput
            size={size}
            accessibilityLabel={t("automation.rateLimit")}
            testID="automation-rate-limit"
            initialValue={state.rateLimit}
            placeholder="20"
            onChangeText={handleRate}
            keyboardType="number-pad"
          />
        </Field>
      ) : null}
    </>
  );
}

function TriggerRow({
  index,
  trigger,
  options,
  dispatch,
  size,
}: {
  index: number;
  trigger: EventTriggerDraft;
  options: EventOption[];
  dispatch: Dispatch<AutomationFormAction>;
  size: ControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const option = options.find((candidate) => candidate.value === trigger.id);
  const display = useMemo(
    () => (trigger.id ? { label: option?.label ?? trigger.id } : null),
    [option, trigger.id],
  );
  const handleEvent = useCallback(
    (id: string) => dispatch({ type: "trigger", index, patch: { id } }),
    [dispatch, index],
  );
  const handleMatch = useCallback(
    (match: string) => dispatch({ type: "trigger", index, patch: { match } }),
    [dispatch, index],
  );
  const handleRemove = useCallback(
    () => dispatch({ type: "removeTrigger", index }),
    [dispatch, index],
  );
  return (
    <View style={styles.trigger} testID={`automation-trigger-${index}`}>
      <View style={styles.row}>
        <View style={styles.grow}>
          <SelectField
            label={t("automation.event")}
            value={trigger.id || null}
            selectedDisplay={display}
            options={options}
            onChange={handleEvent}
            placeholder={t("automation.event")}
            emptyText={t("common.empty.noResults")}
            searchable={options.length > 8}
            title={t("automation.event")}
            size={size}
            field={false}
            triggerTestID={`automation-trigger-event-${index}`}
          />
        </View>
        <Button
          variant="ghost"
          size={size}
          leftIcon={X}
          accessibilityLabel={t("automation.remove")}
          onPress={handleRemove}
          testID={`automation-trigger-remove-${index}`}
        />
      </View>
      <FormTextInput
        size={size}
        accessibilityLabel={t("automation.match")}
        testID={`automation-trigger-match-${index}`}
        initialValue={trigger.match}
        placeholder={(option?.fields ?? ["key"]).map((field) => `${field}=…`).join(", ")}
        onChangeText={handleMatch}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: { gap: theme.spacing[2] },
  nested: { gap: theme.spacing[2], paddingLeft: theme.spacing[3] },
  trigger: {
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  grow: { flex: 1, minWidth: 0 },
  json: { fontFamily: theme.fontFamily.mono, minHeight: 72 },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
