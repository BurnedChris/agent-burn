const BURN_MODE_TIME_ZONE = "Europe/London";

const londonClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: BURN_MODE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export interface LocalClock {
  date: string;
  hour: number;
  minute: number;
}

export function getLondonClock(now = new Date()): LocalClock {
  const parts = Object.fromEntries(
    londonClock
      .formatToParts(now)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );

  const { year, month, day, hour, minute } = parts;

  if (!year || !month || !day || hour === undefined || minute === undefined) {
    throw new Error("Could not resolve the current Europe/London time");
  }

  return {
    date: `${year}-${month}-${day}`,
    hour: Number(hour),
    minute: Number(minute),
  };
}

export function isLondonTime(
  clock: LocalClock,
  hour: number,
  minute: number,
): boolean {
  return clock.hour === hour && clock.minute === minute;
}
