package reminder

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	_ "time/tzdata"
	"unicode/utf8"
)

var clockPattern = regexp.MustCompile(`^(?:[01][0-9]|2[0-3]):[0-5][0-9]$`)

var weekdayIndex = map[string]time.Weekday{
	"sunday":    time.Sunday,
	"monday":    time.Monday,
	"tuesday":   time.Tuesday,
	"wednesday": time.Wednesday,
	"thursday":  time.Thursday,
	"friday":    time.Friday,
	"saturday":  time.Saturday,
}

func normalizeName(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || utf8.RuneCountInString(trimmed) > maxNameRunes {
		return "", ErrInvalid
	}
	return trimmed, nil
}

func normalizePrompt(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || utf8.RuneCountInString(trimmed) > maxPromptRunes {
		return "", ErrInvalid
	}
	return trimmed, nil
}

const (
	minIntervalMinutes = 10
	maxIntervalMinutes = 7 * 24 * 60
	intervalMinuteStep = 10
)

func validateCadence(cadence Cadence) (Cadence, error) {
	timezone := strings.TrimSpace(cadence.Timezone)
	if timezone == "" {
		return Cadence{}, ErrInvalid
	}
	if _, err := time.LoadLocation(timezone); err != nil {
		return Cadence{}, fmt.Errorf("%w: timezone", ErrInvalid)
	}
	kind := strings.TrimSpace(cadence.Kind)
	switch kind {
	case "daily":
		hour, minute, err := requireClock(cadence.Hour, cadence.Minute)
		if err != nil || cadence.Weekdays != nil || cadence.IntervalMinutes != nil || cadence.RunAt != nil {
			return Cadence{}, ErrInvalid
		}
		return Cadence{Kind: kind, Timezone: timezone, Hour: &hour, Minute: &minute}, nil
	case "weekly":
		hour, minute, err := requireClock(cadence.Hour, cadence.Minute)
		if err != nil || cadence.IntervalMinutes != nil || cadence.RunAt != nil {
			return Cadence{}, ErrInvalid
		}
		weekdays, err := normalizeWeekdays(cadence.Weekdays)
		if err != nil {
			return Cadence{}, err
		}
		return Cadence{Kind: kind, Timezone: timezone, Hour: &hour, Minute: &minute, Weekdays: weekdays}, nil
	case "every_n_minutes":
		if cadence.Hour != nil || cadence.Minute != nil || cadence.Weekdays != nil || cadence.RunAt != nil {
			return Cadence{}, ErrInvalid
		}
		if cadence.IntervalMinutes == nil ||
			*cadence.IntervalMinutes < minIntervalMinutes ||
			*cadence.IntervalMinutes > maxIntervalMinutes ||
			*cadence.IntervalMinutes%intervalMinuteStep != 0 {
			return Cadence{}, ErrIntervalInvalid
		}
		minutes := *cadence.IntervalMinutes
		return Cadence{Kind: kind, Timezone: timezone, IntervalMinutes: &minutes}, nil
	case "once":
		if cadence.RunAt == nil || cadence.Hour != nil || cadence.Minute != nil ||
			cadence.Weekdays != nil || cadence.IntervalMinutes != nil {
			return Cadence{}, ErrInvalid
		}
		runAt := cadence.RunAt.UTC().Truncate(time.Second)
		return Cadence{Kind: kind, Timezone: timezone, RunAt: &runAt}, nil
	default:
		return Cadence{}, ErrInvalid
	}
}

// ParseSchedule validates an Agent-facing Schedule and returns a Cadence.
func ParseSchedule(schedule Schedule) (Cadence, error) {
	kind := strings.TrimSpace(schedule.Kind)
	switch kind {
	case "daily", "weekly":
		if schedule.IntervalMinutes != nil || schedule.IntervalHours != nil || schedule.RunAt != nil || (kind == "daily" && schedule.Weekdays != nil) {
			return Cadence{}, ErrInvalid
		}
		hour, minute, err := parseClock(schedule.Time)
		if err != nil {
			return Cadence{}, err
		}
		cadence := Cadence{
			Kind: kind, Timezone: strings.TrimSpace(schedule.Timezone), Hour: &hour, Minute: &minute,
		}
		if kind == "weekly" {
			cadence.Weekdays = schedule.Weekdays
		}
		return validateCadence(cadence)
	case "every_n_minutes":
		if strings.TrimSpace(schedule.Time) != "" || strings.TrimSpace(schedule.Timezone) != "" || schedule.Weekdays != nil || schedule.RunAt != nil || schedule.IntervalHours != nil {
			return Cadence{}, ErrInvalid
		}
		if schedule.IntervalMinutes == nil {
			return Cadence{}, ErrIntervalInvalid
		}
		minutes := *schedule.IntervalMinutes
		return validateCadence(Cadence{Kind: kind, Timezone: "UTC", IntervalMinutes: &minutes})
	case "every_n_hours":
		if strings.TrimSpace(schedule.Time) != "" || strings.TrimSpace(schedule.Timezone) != "" || schedule.Weekdays != nil || schedule.RunAt != nil || schedule.IntervalMinutes != nil {
			return Cadence{}, ErrInvalid
		}
		if schedule.IntervalHours == nil || *schedule.IntervalHours < 1 || *schedule.IntervalHours > maxIntervalMinutes/60 {
			return Cadence{}, ErrIntervalInvalid
		}
		minutes := *schedule.IntervalHours * 60
		return validateCadence(Cadence{Kind: "every_n_minutes", Timezone: "UTC", IntervalMinutes: &minutes})
	case "once":
		if strings.TrimSpace(schedule.Time) != "" || schedule.Weekdays != nil ||
			schedule.IntervalMinutes != nil || schedule.IntervalHours != nil || schedule.RunAt == nil {
			return Cadence{}, ErrInvalid
		}
		timezone := strings.TrimSpace(schedule.Timezone)
		if timezone == "" {
			timezone = "UTC"
		}
		return validateCadence(Cadence{Kind: kind, Timezone: timezone, RunAt: schedule.RunAt})
	default:
		return Cadence{}, ErrInvalid
	}
}

// ScheduleFromCadence projects a persisted Cadence to the Agent-facing Schedule.
func ScheduleFromCadence(cadence Cadence) Schedule {
	if cadence.Kind == "every_n_minutes" {
		return Schedule{Kind: cadence.Kind, IntervalMinutes: cadence.IntervalMinutes}
	}
	if cadence.Kind == "once" {
		return Schedule{Kind: cadence.Kind, Timezone: cadence.Timezone, RunAt: cadence.RunAt}
	}
	schedule := Schedule{Kind: cadence.Kind, Timezone: cadence.Timezone, Weekdays: cadence.Weekdays}
	if cadence.Hour != nil && cadence.Minute != nil {
		schedule.Time = fmt.Sprintf("%02d:%02d", *cadence.Hour, *cadence.Minute)
	}
	return schedule
}

func parseClock(value string) (int, int, error) {
	if !clockPattern.MatchString(value) {
		return 0, 0, ErrInvalid
	}
	hour := int(value[0]-'0')*10 + int(value[1]-'0')
	minute := int(value[3]-'0')*10 + int(value[4]-'0')
	return hour, minute, nil
}

func requireClock(hour, minute *int) (int, int, error) {
	if hour == nil || minute == nil || *hour < 0 || *hour > 23 || *minute < 0 || *minute > 59 {
		return 0, 0, ErrInvalid
	}
	return *hour, *minute, nil
}

// normalizeWeekdays returns one canonical, sorted set of days.
func normalizeWeekdays(days []string) ([]string, error) {
	if len(days) < 1 || len(days) > 7 {
		return nil, ErrInvalid
	}
	result := make([]string, 0, len(days))
	for _, day := range days {
		day = strings.ToLower(strings.TrimSpace(day))
		if _, ok := weekdayIndex[day]; !ok || slices.Contains(result, day) {
			return nil, ErrInvalid
		}
		result = append(result, day)
	}
	slices.SortFunc(result, func(a, b string) int { return (int(weekdayIndex[a])+6)%7 - (int(weekdayIndex[b])+6)%7 })
	return result, nil
}

func nextRunAt(cadence Cadence, after time.Time) (time.Time, error) {
	normalized, err := validateCadence(cadence)
	if err != nil {
		return time.Time{}, err
	}
	after = after.UTC()
	switch normalized.Kind {
	case "daily":
		return nextDaily(*normalized.Hour, *normalized.Minute, normalized.Timezone, after)
	case "weekly":
		var next time.Time
		for _, day := range normalized.Weekdays {
			candidate, err := nextWeekly(*normalized.Hour, *normalized.Minute, day, normalized.Timezone, after)
			if err != nil {
				return time.Time{}, err
			}
			if next.IsZero() || candidate.Before(next) {
				next = candidate
			}
		}
		return next, nil
	case "every_n_minutes":
		next := after.Add(time.Duration(*normalized.IntervalMinutes) * time.Minute)
		if !next.After(after) {
			return time.Time{}, ErrInvalid
		}
		return next, nil
	case "once":
		// A one-shot time already past has no next occurrence.
		if !normalized.RunAt.After(after) {
			return time.Time{}, ErrInvalid
		}
		return *normalized.RunAt, nil
	default:
		return time.Time{}, ErrInvalid
	}
}

// nextOccurrenceAt advances a fired or skipped occurrence to the next future
// slot. Interval cadences advance on the fixed dueAt + k*interval grid so
// scheduling latency never accumulates drift and downtime never replays missed
// slots.
func nextOccurrenceAt(cadence Cadence, dueAt, now time.Time) (time.Time, error) {
	normalized, err := validateCadence(cadence)
	if err != nil {
		return time.Time{}, err
	}
	if normalized.Kind == "every_n_minutes" {
		return nextIntervalRunAt(dueAt, now, time.Duration(*normalized.IntervalMinutes)*time.Minute)
	}
	return nextRunAt(normalized, maxTime(now, dueAt))
}

func nextIntervalRunAt(dueAt, now time.Time, interval time.Duration) (time.Time, error) {
	if interval <= 0 {
		return time.Time{}, ErrInvalid
	}
	dueAt = dueAt.UTC()
	now = now.UTC()
	if now.Before(dueAt) {
		return dueAt.Add(interval), nil
	}
	steps := int64(now.Sub(dueAt)/interval) + 1
	return dueAt.Add(time.Duration(steps) * interval), nil
}

func nextDaily(hour, minute int, timezone string, after time.Time) (time.Time, error) {
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return time.Time{}, err
	}
	local := after.In(location)
	// Each candidate is built from its own calendar day: time.Date moves a
	// clock time that a DST change skips, and shifting that result would
	// carry the moved clock to the next days. Two days ahead covers a gap
	// at midnight, which can move the next day's slot back to after or
	// earlier.
	for day := 0; day <= 2; day++ {
		candidate := time.Date(local.Year(), local.Month(), local.Day()+day, hour, minute, 0, 0, location)
		if candidate.After(after) {
			return candidate.UTC(), nil
		}
	}
	return time.Time{}, ErrInvalid
}

func nextWeekly(hour, minute int, weekdayName, timezone string, after time.Time) (time.Time, error) {
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return time.Time{}, err
	}
	wanted, ok := weekdayIndex[weekdayName]
	if !ok {
		return time.Time{}, ErrInvalid
	}
	local := after.In(location)
	days := int(wanted - local.Weekday())
	if days < 0 {
		days += 7
	}
	// Pick the calendar date before resolving its clock across an offset change.
	candidate := time.Date(local.Year(), local.Month(), local.Day()+days, hour, minute, 0, 0, location)
	if !candidate.After(after) {
		candidate = time.Date(local.Year(), local.Month(), local.Day()+days+7, hour, minute, 0, 0, location)
	}
	if !candidate.After(after) {
		return time.Time{}, ErrInvalid
	}
	return candidate.UTC(), nil
}

func maxTime(left, right time.Time) time.Time {
	if right.After(left) {
		return right
	}
	return left
}
