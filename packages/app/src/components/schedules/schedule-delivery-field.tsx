import { useCallback, useMemo, type ReactElement } from "react";
import type { ScheduleDelivery } from "@getpaseo/protocol/schedule/types";
import { ComboboxItem } from "@/components/ui/combobox";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
  type SelectFieldRenderOptionInput,
} from "@/components/ui/select-field";
import { useScheduleChannels } from "@/hooks/use-schedule-channels";
import {
  buildScheduleDeliveryFieldModel,
  deliveryOptionValue,
  formatRawDelivery,
  type ScheduleDeliveryOption,
} from "@/schedules/schedule-delivery";

const LABEL = "Deliver results";
const EMPTY_HINT = "Plugins can register delivery channels to send each run's result somewhere.";

interface ScheduleDeliveryFieldProps {
  serverId: string;
  value: ScheduleDelivery | null;
  onChange: (value: ScheduleDelivery | null) => void;
  size: FieldControlSize;
}

/**
 * Where each run's result goes. People pick a destination by its label; the raw `channel:to`
 * appears only for a stored target no running plugin offers any more.
 */
export function ScheduleDeliveryField({
  serverId,
  value,
  onChange,
  size,
}: ScheduleDeliveryFieldProps): ReactElement {
  const { channels, isLoading, error } = useScheduleChannels({ serverId, enabled: true });
  const fieldModel = useMemo(
    () => buildScheduleDeliveryFieldModel({ channels, isLoading, error, current: value }),
    [channels, error, isLoading, value],
  );
  const options = useMemo<ScheduleDeliveryOption[]>(
    () => (fieldModel.kind === "ready" ? fieldModel.options : []),
    [fieldModel],
  );
  const optionByValue = useMemo(
    () => new Map(options.map((option) => [option.value, option])),
    [options],
  );
  const selectedValue = deliveryOptionValue(value);
  const selectedDisplay = useMemo<SelectFieldDisplay>(() => {
    const selected = optionByValue.get(selectedValue);
    if (selected) {
      return { label: selected.label, description: selected.description };
    }
    return { label: value ? formatRawDelivery(value) : "None" };
  }, [optionByValue, selectedValue, value]);
  const handleChange = useCallback(
    (next: string) => {
      const option = optionByValue.get(next);
      if (!option || option.unavailable || option.delivery === undefined) {
        return;
      }
      onChange(option.delivery);
    },
    [onChange, optionByValue],
  );
  const renderOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => (
      <DeliveryOptionItem
        {...input}
        unavailable={optionByValue.get(input.option.value)?.unavailable}
      />
    ),
    [optionByValue],
  );

  let hint: string | undefined;
  if (fieldModel.kind === "empty") {
    hint = EMPTY_HINT;
  } else if (fieldModel.kind === "error") {
    hint = `Could not load delivery channels: ${fieldModel.message}`;
  }

  return (
    <SelectField
      label={LABEL}
      value={selectedValue}
      selectedDisplay={selectedDisplay}
      options={options satisfies SelectFieldOption<string>[]}
      onChange={handleChange}
      placeholder="None"
      emptyText="No delivery channels"
      loading={fieldModel.kind === "loading"}
      disabled={fieldModel.kind === "empty" || fieldModel.kind === "error"}
      hint={hint}
      searchable={options.length > 8}
      searchPlaceholder="Search destinations..."
      title={LABEL}
      size={size}
      testID="schedule-delivery"
      triggerTestID="schedule-delivery-trigger"
      renderOption={renderOption}
    />
  );
}

function DeliveryOptionItem({
  option,
  selected,
  active,
  onPress,
  unavailable,
}: SelectFieldRenderOptionInput<string> & { unavailable: boolean | undefined }): ReactElement {
  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      description={option.description}
      selected={selected}
      active={active}
      disabled={unavailable === true}
      onPress={onPress}
    />
  );
}
